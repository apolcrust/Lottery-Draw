import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type * as XLSX from "xlsx";
import {
  Ban, Check, EyeOff, CircleHelp, Clock3, Copy, Download, FileSpreadsheet, Fullscreen, History, Keyboard,
  ListPlus, LoaderCircle, LockKeyhole, Plus, RotateCcw, Search, Settings2, ShieldCheck,
  Music, Sparkles, Trash2, Trophy, Upload, VolumeX, X,
} from "lucide-react";
import { pruneExcluded, selectWinner } from "./engine";
import { ballColorFor, formatTicket } from "./ballColors";
import { formatWinnerTime, winnersInDrawOrder } from "./winnerHistory";
import { loadData, publicEventData, saveData, validateData } from "./storage";
import type { AppData, DrawTicket, LotterySettings, Participant, Winner } from "./types";
import { DEFAULT_DATA, DEFAULT_SETTINGS, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS } from "./types";
import { LotteryMachine } from "./components/LotteryMachine";
import { WinnerAnnouncement } from "./components/WinnerAnnouncement";
import { remainingMixMs, type MachinePhase } from "./machineTimeline";
import { useOperatorShortcut } from "./operatorShortcut";
import { supabase, supabaseConfigurationError } from "./supabaseClient";
import { findDuplicateParticipantIds, normalizeParticipantName, removeDuplicateParticipants } from "./participants";
import {
  beginLotteryDraw, cancelLotteryDraw, clearPendingDraw, createLotteryEvent, deleteLotteryEvent, errorText,
  fetchLotteryEvent, fetchOverride, finishLotteryDraw, importLotteryParticipants, listOwnedEvents, loadPendingDraw,
  manageLotteryParticipants, saveLotteryEventData, savePendingDraw, setExcluded, setOverride, subscribeToLotteryEvent,
  type LotteryEventRow, type OwnedEventSummary, type ParticipantAction,
} from "./services/lotteryService";
import type { Session } from "@supabase/supabase-js";
import drawMusicUrl from "./assets/mangarap.mp3?url";

type Dialog = "participants" | "import" | "settings" | "history" | null;
type Toast = { id: number; message: string; tone: "success" | "error" };
type ImportEntry = { name: string; weight: number };
type RemoteDraw = { mixTimer: number; fallbackTimer: number; mixDone: boolean; winner: Winner | null; data: AppData | null; revealDone: boolean };
type LocalPick = { participant: Participant; mode: Winner["mode"]; ticketNumber: number };
type DrawOutcome = { winner: Winner; completed: AppData | null };

function makeParticipant(name: string, weight = 1): Participant {
  return { id: crypto.randomUUID(), name: name.trim(), weight };
}

function playTone(frequency: number, duration: number, volume: number) {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) throw new Error("Audio is not supported by this browser.");
  const context = new AudioContextConstructor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(Math.max(0.001, volume * 0.11), context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration);
  oscillator.onended = () => void context.close();
}

function keyLabel(code: string) {
  return code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
}

function winnerKey(winner: Winner | undefined) {
  return winner ? `${winner.drawNumber}:${winner.participant.id}:${winner.timestamp}` : null;
}

function modeLabel(mode: Winner["mode"]) {
  return mode === "controlled" ? "OPERATOR PICK" : mode === "weighted" ? "WEIGHTED DRAW" : "RANDOM DRAW";
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function App() {
  const basePath = import.meta.env.BASE_URL.replace(/\/+$/, "");
  const currentPath = window.location.pathname.replace(/\/+$/, "");
  const searchParams = new URLSearchParams(window.location.search);
  const eventId = searchParams.get("event");
  const isOperator = currentPath === "/operator" ||
    (searchParams.get("view") === "operator" && currentPath === basePath);
  const [data, setData] = useState<AppData>(DEFAULT_DATA);
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(!!supabase);
  const [authEmail, setAuthEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [eventOwnerId, setEventOwnerId] = useState<string | null>(null);
  const [serverDrawing, setServerDrawing] = useState(false);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [lastWinner, setLastWinner] = useState<Winner | null>(null);
  const [machinePhase, setMachinePhase] = useState<MachinePhase>("idle");
  const [ballNumber, setBallNumber] = useState<number | null>(null);
  const winnerListRef = useRef<HTMLUListElement>(null);
  const [recovery, setRecovery] = useState<{ ticket: DrawTicket; message: string } | null>(null);
  const [resumeTicket, setResumeTicket] = useState<DrawTicket | null>(null);
  const [ownedEvents, setOwnedEvents] = useState<OwnedEventSummary[]>([]);
  const [drawMusicEnabled, setDrawMusicEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("lottery-ball-system-music-muted") !== "true";
    } catch (error) {
      console.error("Could not read the draw music preference.", error);
      return true;
    }
  });
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [importBook, setImportBook] = useState<XLSX.WorkBook | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [sheetRows, setSheetRows] = useState<Record<string, unknown[][]>>({});
  const [sheetName, setSheetName] = useState("");
  const [columnIndex, setColumnIndex] = useState(0);
  const [weightColumn, setWeightColumn] = useState(-1);
  const [hasHeader, setHasHeader] = useState(true);
  const [importAction, setImportAction] = useState<"append" | "replace">("append");
  const [keepDuplicates, setKeepDuplicates] = useState(false);
  const backupInput = useRef<HTMLInputElement>(null);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [customPalette, setCustomPalette] = useState("");
  const [overrideSearch, setOverrideSearch] = useState("");
  const [importPending, setImportPending] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const toastSequence = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabId = useRef(crypto.randomUUID());
  const receivedDataRef = useRef<AppData | null>(null);
  const receivedBroadcastRef = useRef(false);
  const lastSavedRef = useRef("");
  const lastWinnerKeyRef = useRef<string | null>(null);
  const localDrawRef = useRef(false);
  const mountedRef = useRef(true);
  const revealResolver = useRef<(() => void) | null>(null);
  const remoteRef = useRef<RemoteDraw | null>(null);
  const skewRef = useRef(0);
  const overridePending = useRef(0);
  const overrideQueue = useRef<Promise<void>>(Promise.resolve());
  const dataRef = useRef(data);
  dataRef.current = data;

  const notify = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = ++toastSequence.current;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ----- draw music ---------------------------------------------------------------------------------------
  const startMusic = (enabled = drawMusicEnabled, quiet = false) => {
    if (!enabled) return;
    let audio = musicRef.current;
    if (!audio) {
      audio = new Audio(drawMusicUrl);
      audio.preload = "auto";
      audio.loop = true;
      audio.volume = 0.7;
      musicRef.current = audio;
    }
    audio.currentTime = 0;
    try {
      void audio.play().catch((error: unknown) => {
        if (!quiet) notify(errorText(error, "Draw music could not be played."), "error");
      });
    } catch (error) {
      if (!quiet) notify(errorText(error, "Draw music could not be played."), "error");
    }
  };

  const stopMusic = () => {
    const audio = musicRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  };

  const toggleMusic = () => {
    const enabled = !drawMusicEnabled;
    setDrawMusicEnabled(enabled);
    try {
      window.localStorage.setItem("lottery-ball-system-music-muted", String(!enabled));
    } catch (error) {
      notify(errorText(error, "The music preference could not be saved."), "error");
    }
    if (enabled && (machinePhase === "mixing" || machinePhase === "revealing" || machinePhase === "revealed")) startMusic(true);
    else stopMusic();
  };

  useEffect(() => () => {
    const audio = musicRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    musicRef.current = null;
  }, []);

  // ----- presenting a finished draw -----------------------------------------------------------------------
  const showWinner = useCallback((winner: Winner, settings: LotterySettings) => {
    lastWinnerKeyRef.current = winnerKey(winner);
    setBallNumber(winner.ticketNumber);
    setMachinePhase("revealed");
    setLastWinner(winner);
    if (settings.sound) {
      try { playTone(660, 0.55, 0.85); }
      catch (error) { notify(errorText(error, "Winner sound could not be played."), "error"); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  const continueFromWinner = () => {
    stopMusic();
    setLastWinner(null);
    setMachinePhase("idle");
  };

  const waitForReveal = () => new Promise<void>((resolve) => { revealResolver.current = resolve; });
  const handleRevealComplete = useCallback(() => {
    const resolve = revealResolver.current;
    revealResolver.current = null;
    resolve?.();
  }, []);

  // ----- auth -----------------------------------------------------------------------------------------------
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
    });
    supabase.auth.getSession().then(({ data: result, error }) => {
      if (error) throw error;
      if (active) {
        setSession(result.session);
        setAuthLoading(false);
      }
    }).catch((error: unknown) => {
      if (active) {
        setStorageError(errorText(error, "Could not check the operator sign-in session."));
        setAuthLoading(false);
      }
    });
    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  // ----- presentation of draws started on ANOTHER device or tab -------------------------------------------
  const finishRemotePresentation = useCallback((state: RemoteDraw) => {
    if (remoteRef.current !== state || !state.winner || !state.revealDone) return;
    window.clearTimeout(state.fallbackTimer);
    remoteRef.current = null;
    // The new roster/history is applied only now, so audience screens never show the winner before the reveal.
    if (state.data) {
      receivedDataRef.current = state.data;
      setData(state.data);
    }
    showWinner(state.winner, state.data?.settings ?? dataRef.current.settings);
  }, [showWinner]);

  const startRemoteReveal = useCallback((state: RemoteDraw) => {
    if (remoteRef.current !== state) return;
    state.mixDone = true;
    setMachinePhase("revealing");
    revealResolver.current = () => {
      state.revealDone = true;
      finishRemotePresentation(state);
    };
  }, [finishRemotePresentation]);

  const abortRemotePresentation = useCallback(() => {
    const state = remoteRef.current;
    if (!state) return;
    window.clearTimeout(state.mixTimer);
    window.clearTimeout(state.fallbackTimer);
    remoteRef.current = null;
    revealResolver.current = null;
    stopMusic();
    setMachinePhase("idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resyncRef = useRef<() => void>(() => undefined);

  const beginRemoteDraw = useCallback((startedAt: string | null, durationMs: number | null) => {
    if (remoteRef.current || localDrawRef.current) return;
    const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    const total = durationMs ?? dataRef.current.settings.duration * 1000;
    const remaining = Number.isNaN(startedAtMs) ? total : remainingMixMs(startedAtMs, total, Date.now(), skewRef.current);
    const state: RemoteDraw = { mixTimer: 0, fallbackTimer: 0, mixDone: false, winner: null, data: null, revealDone: false };
    remoteRef.current = state;
    setLastWinner(null);
    setBallNumber(null);
    setMachinePhase("mixing");
    if (dataRef.current.settings.sound) startMusic(drawMusicEnabled, true);
    state.mixTimer = window.setTimeout(() => startRemoteReveal(state), remaining);
    // If the result never arrives (initiating device lost its connection) re-sync instead of hanging.
    state.fallbackTimer = window.setTimeout(() => resyncRef.current(), remaining + 30000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRemoteReveal, drawMusicEnabled]);

  const receiveRemoteWinner = useCallback((winner: Winner, nextData: AppData) => {
    if (localDrawRef.current) return;
    let state = remoteRef.current;
    if (!state) {
      // The result arrived before this device saw the draw start: play the reveal straight away.
      state = { mixTimer: 0, fallbackTimer: 0, mixDone: true, winner: null, data: null, revealDone: false };
      remoteRef.current = state;
      setLastWinner(null);
      startRemoteReveal(state);
    }
    state.winner = winner;
    state.data = nextData;
    setBallNumber(winner.ticketNumber);
    finishRemotePresentation(state);
  }, [startRemoteReveal, finishRemotePresentation]);

  useEffect(() => () => {
    const state = remoteRef.current;
    if (state) { window.clearTimeout(state.mixTimer); window.clearTimeout(state.fallbackTimer); }
  }, []);

  // ----- local multi-tab sync (only used when Supabase is not configured) --------------------------------
  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const channel = new BroadcastChannel("lottery-ball-session");
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<
      | { sender: string; type: "data"; data: AppData }
      | { sender: string; type: "draw"; busy: boolean; startedAt?: string; durationMs?: number }
    >) => {
      if (event.data.sender === tabId.current) return;
      if (event.data.type === "draw") {
        if (event.data.busy) {
          setServerDrawing(true);
          beginRemoteDraw(event.data.startedAt ?? null, event.data.durationMs ?? null);
        } else {
          setServerDrawing(false);
          // A finished draw is followed by a data message carrying the winner; if none comes, abort.
          window.setTimeout(() => {
            const state = remoteRef.current;
            if (state && !state.winner) abortRemotePresentation();
          }, 1500);
        }
        return;
      }
      const receivedData = event.data.data;
      const latest = receivedData.winners[0];
      const key = winnerKey(latest);
      receivedBroadcastRef.current = true;
      if (latest && key !== lastWinnerKeyRef.current && !localDrawRef.current) {
        lastWinnerKeyRef.current = key;
        receiveRemoteWinner(latest, receivedData); // applied after the reveal
        return;
      }
      receivedDataRef.current = receivedData;
      setData((current) => JSON.stringify(current) === JSON.stringify(receivedData) ? current : receivedData);
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [beginRemoteDraw, receiveRemoteWinner, abortRemotePresentation]);

  // ----- load the event (shared Supabase event, or the local browser session) -------------------------------
  const applyRow = useCallback((row: LotteryEventRow, initial: boolean) => {
    setEventOwnerId(row.ownerId);
    setServerDrawing(row.isDrawing);
    setStorageError("");
    const incoming = row.data;
    const latest = incoming.winners[0];
    const key = winnerKey(latest);
    if (initial) {
      lastWinnerKeyRef.current = key;
      receivedDataRef.current = incoming;
      setData(incoming);
      setCustomPalette(incoming.settings.colors.join(", "));
      return;
    }
    // Operator-only fields are private: keep this device's copy of them, never take them from the row.
    const merged: AppData = {
      ...incoming,
      overrideParticipantId: dataRef.current.overrideParticipantId,
      overrideActivated: dataRef.current.overrideActivated,
    };
    merged.excludedParticipantIds = pruneExcluded(dataRef.current.excludedParticipantIds, incoming.participants);
    const keepLocalOverride = merged.overrideParticipantId !== null &&
      incoming.participants.some((person) => person.id === merged.overrideParticipantId);
    if (!keepLocalOverride) { merged.overrideParticipantId = null; merged.overrideActivated = false; }
    if (!row.isDrawing && latest && key !== lastWinnerKeyRef.current) {
      // A new winner: the roster and history are applied only after this device has played the reveal.
      lastWinnerKeyRef.current = key;
      receiveRemoteWinner(latest, merged);
      return;
    }
    receivedDataRef.current = merged;
    setData((current) => JSON.stringify(publicEventData(current)) === JSON.stringify(publicEventData(merged)) &&
      current.overrideParticipantId === merged.overrideParticipantId && current.overrideActivated === merged.overrideActivated
      ? current : merged);

    if (row.isDrawing) {
      beginRemoteDraw(row.drawStartedAt, row.drawDurationMs);
    } else if (remoteRef.current && !remoteRef.current.winner) {
      abortRemotePresentation();
    }
  }, [beginRemoteDraw, receiveRemoteWinner, abortRemotePresentation]);

  const refreshOverride = useCallback(async () => {
    if (!supabase || !eventId || !isOperator || overridePending.current > 0) return;
    try {
      const secret = await fetchOverride(supabase, eventId);
      if (overridePending.current > 0 || !mountedRef.current) return;
      setData((current) => current.overrideParticipantId === secret.overrideParticipantId &&
        current.overrideActivated === secret.overrideActivated &&
        JSON.stringify(current.excludedParticipantIds) === JSON.stringify(secret.excludedParticipantIds) ? current : { ...current, ...secret });
    } catch (error) {
      notify(errorText(error, "The predetermined winner could not be loaded."), "error");
    }
  }, [eventId, isOperator, notify]);

  resyncRef.current = () => {
    const client = supabase;
    if (!client || !eventId) return;
    void fetchLotteryEvent(client, eventId).then((row) => {
      if (!row || !mountedRef.current) return;
      applyRow(row, false);
      if (!row.isDrawing) abortRemotePresentation();
    }).catch((error: unknown) => setStorageError(errorText(error, "The shared lottery could not be refreshed.")));
  };

  useEffect(() => {
    let active = true;
    if (supabase) {
      const client = supabase;
      if (!eventId || (isOperator && authLoading) || (isOperator && !session)) {
        setReady(true);
        return () => { active = false; };
      }
      setReady(false);
      void (async () => {
        try {
          const row = await fetchLotteryEvent(client, eventId);
          if (!row) throw new Error("This shared lottery event was not found or is no longer available.");
          let initial = row.data;
          if (isOperator && session?.user.id === row.ownerId) {
            const secret = await fetchOverride(client, eventId);
            initial = { ...initial, ...secret };
          }
          if (!active) return;
          applyRow({ ...row, data: initial }, true);
          const pending = loadPendingDraw(eventId);
          if (pending && row.isDrawing) setResumeTicket(pending);
          else {
            if (pending) clearPendingDraw(eventId);
            if (row.isDrawing) beginRemoteDraw(row.drawStartedAt, row.drawDurationMs);
          }
          setReady(true);
        } catch (error) {
          if (active) {
            setStorageError(errorText(error, "Could not load the shared lottery event."));
            setReady(true);
          }
        }
      })();
      return () => { active = false; };
    }

    loadData().then((stored) => {
      if (active) {
        if (!receivedBroadcastRef.current) {
          lastWinnerKeyRef.current = winnerKey(stored.winners[0]);
          receivedDataRef.current = stored;
          setData(stored);
          setCustomPalette(stored.settings.colors.join(", "));
        }
        setReady(true);
      }
    }).catch((error: unknown) => {
      if (active) {
        setStorageError(errorText(error, "Local storage could not be opened."));
      }
    });
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, isOperator, authLoading, session?.user.id]);

  // ----- realtime -------------------------------------------------------------------------------------------
  useEffect(() => {
    const client = supabase;
    if (!client || !eventId || !ready || !eventOwnerId) return;
    return subscribeToLotteryEvent(client, eventId, ({ row, commitTimestamp }) => {
      if (commitTimestamp) {
        const skew = Date.now() - Date.parse(commitTimestamp);
        skewRef.current = Number.isFinite(skew) && Math.abs(skew) < 5 * 60_000 ? skew : 0;
      }
      if (localDrawRef.current) {
        // This tab is driving the draw; it applies the authoritative result itself.
        setEventOwnerId(row.ownerId);
        return;
      }
      applyRow(row, false);
      if (isOperator) void refreshOverride();
    }, (message) => setStorageError(message));
  }, [eventId, ready, eventOwnerId, isOperator, applyRow, refreshOverride]);

  // ----- persistence ----------------------------------------------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const receivedRemoteData = receivedDataRef.current === data;
    if (receivedRemoteData) {
      receivedDataRef.current = null;
      // The server already has exactly this data; remember it so it is never re-saved.
      if (supabase && eventId) lastSavedRef.current = JSON.stringify(publicEventData(data));
    }
    if (!supabase) {
      saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
        await saveData(data);
        channelRef.current?.postMessage({ sender: tabId.current, type: "data", data });
      }).catch((error: unknown) => {
        setStorageError(errorText(error, "Your changes could not be saved."));
      });
    }
    const remoteClient = supabase;
    if (remoteClient && eventId && isOperator && session?.user.id === eventOwnerId && !receivedRemoteData && !serverDrawing) {
      const snapshot = JSON.stringify(publicEventData(data));
      if (snapshot === lastSavedRef.current) return;
      const ownerId = session.user.id;
      const saveTimer = window.setTimeout(() => {
        void (async () => {
          try {
            await saveLotteryEventData(remoteClient, eventId, ownerId, data);
            lastSavedRef.current = snapshot;
            setStorageError("");
          } catch (error) {
            setStorageError(errorText(error, "The shared lottery could not be saved."));
          }
        })();
      }, 250);
      return () => window.clearTimeout(saveTimer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, ready, eventId, isOperator, session?.user.id, eventOwnerId]);

  // ----- operator shortcut capture ----------------------------------------------------------------------------
  useEffect(() => {
    if (!capturingShortcut) return;
    const capture = (event: KeyboardEvent) => {
      if (busy) {
        setCapturingShortcut(false);
        return;
      }
      if (event.key === "Escape") {
        setCapturingShortcut(false);
        return;
      }
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        notify("Use an unmodified letter or number key for the operator shortcut.", "error");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!/^Key[A-Z]$/.test(event.code) && !/^Digit[0-9]$/.test(event.code)) {
        notify("Use an unmodified letter or number key for the operator shortcut.", "error");
        return;
      }
      setData((current) => ({ ...current, settings: { ...current.settings, shortcut: event.code } }));
      setCapturingShortcut(false);
      notify(`Override shortcut set to ${keyLabel(event.code)}.`);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [capturingShortcut, busy, notify]);

  // ----- derived state ------------------------------------------------------------------------------------------
  const isOwner = !!session && session.user.id === eventOwnerId;
  const rosterLocked = !!supabase && !isOperator && !data.settings.audienceCanManageRoster && !isOwner;
  const canDraw = !supabase || data.settings.audienceCanDraw || isOwner;
  const drawActive = machinePhase === "mixing" || machinePhase === "revealing";
  const drawLocked = busy || serverDrawing || drawActive || importPending;
  const useRpcRoster = !!supabase && !!eventId && !isOperator;
  const canEditEvent = isOperator || !supabase;
  const eligibleOverride = !!data.overrideParticipantId &&
    data.participants.some((participant) => participant.id === data.overrideParticipantId);
  const filteredOverrideParticipants = useMemo(() => {
    const query = overrideSearch.trim().toLocaleLowerCase();
    return data.participants
      .map((participant, index) => ({ participant, index }))
      .filter(({ participant }) => participant.name.toLocaleLowerCase().includes(query));
  }, [data.participants, overrideSearch]);
  const selectedOverrideParticipant = data.participants.find((person) => person.id === data.overrideParticipantId);
  const excludedSet = useMemo(() => new Set(data.excludedParticipantIds), [data.excludedParticipantIds]);
  const excludedParticipants = useMemo(
    () => data.participants.map((participant, index) => ({ participant, index })).filter(({ participant }) => excludedSet.has(participant.id)),
    [data.participants, excludedSet],
  );
  const [excludeSearch, setExcludeSearch] = useState("");
  const filteredExcludeParticipants = useMemo(() => {
    const query = excludeSearch.trim().toLocaleLowerCase();
    return data.participants
      .map((participant, index) => ({ participant, index }))
      .filter(({ participant }) => participant.name.toLocaleLowerCase().includes(query));
  }, [data.participants, excludeSearch]);
  const duplicateParticipantIds = useMemo(() => findDuplicateParticipantIds(data.participants), [data.participants]);
  const newNameAlreadyExists = !isOperator && newName.trim() !== "" && data.participants.some(
    (person) => normalizeParticipantName(person.name) === normalizeParticipantName(newName),
  );
  const ballColor = ballColorFor(data.settings.colors, ballNumber);
  const drawStatus = machinePhase === "mixing" ? "Mixing the balls…"
    : machinePhase === "revealing" ? "The winning ball is rising…"
      : busy || serverDrawing ? "Preparing the draw…"
        : machinePhase === "revealed" ? "We have a winner!" : data.participants.length === 0 ? "Add participants to begin" : "Ready to draw";

  // ----- predetermined winner (operator only; stored privately in Supabase, never in the public event data) -----
  const commitOverride = useCallback((participantId: string | null, armed: boolean) => {
    setData((current) => ({ ...current, overrideParticipantId: participantId, overrideActivated: armed }));
    const client = supabase;
    if (client && eventId && isOperator) {
      overridePending.current += 1;
      overrideQueue.current = overrideQueue.current.catch(() => undefined)
        .then(() => setOverride(client, eventId, participantId, armed))
        .catch((error: unknown) => notify(errorText(error, "The predetermined winner could not be saved."), "error"))
        .finally(() => { overridePending.current -= 1; });
    }
  }, [eventId, isOperator, notify]);

  // The excluded list is operator-only and stored privately, exactly like the one-time pick.
  const commitExcluded = useCallback((ids: string[]) => {
    setData((current) => ({ ...current, excludedParticipantIds: ids }));
    const client = supabase;
    if (client && eventId && isOperator) {
      overridePending.current += 1;
      overrideQueue.current = overrideQueue.current.catch(() => undefined)
        .then(() => setExcluded(client, eventId, ids))
        .catch((error: unknown) => notify(errorText(error, "The excluded list could not be saved."), "error"))
        .finally(() => { overridePending.current -= 1; });
    }
  }, [eventId, isOperator, notify]);

  const toggleExcluded = (id: string) => {
    if (drawLocked) return;
    const current = dataRef.current.excludedParticipantIds;
    commitExcluded(current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  };

  // winners and removed people drop out of the excluded list automatically
  useEffect(() => {
    if (!(isOperator || !supabase) || data.excludedParticipantIds.length === 0) return;
    const valid = pruneExcluded(data.excludedParticipantIds, data.participants);
    if (valid.length !== data.excludedParticipantIds.length) commitExcluded(valid);
  }, [data.participants, data.excludedParticipantIds, isOperator, commitExcluded]);

  const activateOverride = useCallback(() => {
    if (!eligibleOverride || drawLocked) return;
    commitOverride(dataRef.current.overrideParticipantId, true);
    notify("One-time pick activated. It will be used for the next draw.");
  }, [eligibleOverride, drawLocked, commitOverride, notify]);
  const operatorShortcut = useCallback(() => {
    if (!isOperator) return;
    activateOverride();
  }, [isOperator, activateOverride]);
  useOperatorShortcut(isOperator ? data.settings.shortcut : "", drawLocked, eligibleOverride, operatorShortcut);

  const updateSettings = (update: Partial<LotterySettings>) => {
    setData((current) => ({ ...current, settings: { ...current.settings, ...update } }));
  };

  /** Applies data returned by a validated database function while keeping this device's private operator state. */
  const adoptServerData = (updated: AppData) => {
    const current = dataRef.current;
    const keep = !!current.overrideParticipantId && updated.participants.some((person) => person.id === current.overrideParticipantId);
    const merged: AppData = {
      ...updated,
      overrideParticipantId: keep ? current.overrideParticipantId : null,
      overrideActivated: keep ? current.overrideActivated : false,
      excludedParticipantIds: pruneExcluded(current.excludedParticipantIds, updated.participants),
    };
    receivedDataRef.current = merged;
    setData(merged);
  };

  // ----- the draw ---------------------------------------------------------------------------------------------------
  // Asks the database to finish the draw (or, in local mode, builds the winner record). Does not change what is on screen.
  const resolveDraw = async (ticket: DrawTicket, local: LocalPick | null): Promise<DrawOutcome> => {
    if (supabase && eventId) {
      const completed = await finishLotteryDraw(supabase, eventId, ticket.drawId);
      const winner = completed.winners[0];
      if (!winner) throw new Error("The draw finished without a winner record.");
      setBallNumber(winner.ticketNumber); // the number on the winning ball
      return { winner, completed };
    }
    if (!local) throw new Error("The local draw has no selected participant.");
    const winner: Winner = {
      participant: local.participant,
      drawNumber: dataRef.current.winners.length + 1,
      ticketNumber: local.ticketNumber,
      timestamp: new Date().toISOString(),
      mode: local.mode,
    };
    setBallNumber(winner.ticketNumber);
    return { winner, completed: null };
  };

  // Puts the finished draw on screen: roster, history and the winner announcement.
  const applyOutcome = (outcome: DrawOutcome) => {
    if (outcome.completed && eventId) {
      clearPendingDraw(eventId);
      setRecovery(null);
      setServerDrawing(false);
      adoptServerData(outcome.completed);
      showWinner(outcome.winner, outcome.completed.settings);
      return;
    }
    const record = outcome.winner;
    const settings = dataRef.current.settings;
    setData((state) => ({
      ...state,
      participants: state.settings.autoRemove
        ? state.participants.filter((person) => person.id !== record.participant.id)
        : state.participants,
      winners: [record, ...state.winners],
      overrideParticipantId: record.mode === "controlled" ? null : state.overrideParticipantId,
      overrideActivated: record.mode === "controlled" ? false : state.overrideActivated,
    }));
    lastWinnerKeyRef.current = winnerKey(record);
    showWinner(record, settings);
  };

  const handleFinishFailure = (ticket: DrawTicket, error: unknown) => {
    const message = errorText(error, "The draw result could not be confirmed.");
    stopMusic();
    if (/no longer active|does not belong|no active draw|not found/i.test(message)) {
      // The draw was cancelled or expired on the server: nothing to retry.
      if (eventId) clearPendingDraw(eventId);
      setRecovery(null);
      setServerDrawing(false);
      setMachinePhase("idle");
      notify(message, "error");
    } else {
      setMachinePhase("revealed");
      setRecovery({ ticket, message });
    }
  };

  const runDraw = async (ticket: DrawTicket, local: LocalPick | null, resumed: boolean) => {
    localDrawRef.current = true;
    setBusy(true);
    const settings = dataRef.current.settings;
    try {
      setBallNumber(null);
      setMachinePhase("mixing");
      startMusic();
      if (settings.sound && !resumed) {
        try { playTone(220, 0.18, 0.45); }
        catch (error) { notify(errorText(error, "Draw sound could not be played."), "error"); }
      }
      const mixMs = resumed
        ? remainingMixMs(Date.parse(ticket.startedAt), ticket.durationMs, Date.now(), skewRef.current)
        : ticket.durationMs;
      await sleep(mixMs);
      if (!mountedRef.current) return;
      setMachinePhase("revealing");
      // The database finishes the draw while the ball rises, so its number is known when it is pulled into focus.
      const pending = resolveDraw(ticket, local);
      pending.catch(() => undefined);
      await waitForReveal();
      if (!mountedRef.current) return;
      let outcome: DrawOutcome;
      try {
        outcome = await pending;
      } catch (error) {
        if (supabase && eventId) { handleFinishFailure(ticket, error); return; }
        throw error;
      }
      applyOutcome(outcome);
    } catch (error) {
      stopMusic();
      setMachinePhase("idle");
      notify(errorText(error, "The lottery draw could not be completed."), "error");
    } finally {
      localDrawRef.current = false;
      setBusy(false);
      if (!supabase) channelRef.current?.postMessage({ sender: tabId.current, type: "draw", busy: false });
    }
  };

  const startDraw = async () => {
    if (drawLocked || isOperator) return;
    if (!canDraw) {
      notify("Only the event operator can start a draw for this event.", "error");
      return;
    }
    if (data.participants.length === 0) {
      notify("Add participants before starting a draw.", "error");
      return;
    }
    localDrawRef.current = true;
    setBusy(true);
    setLastWinner(null);
    setRecovery(null);
    let ticket: DrawTicket;
    let local: LocalPick | null = null;
    try {
      if (supabase && eventId) {
        // The database selects the winner and keeps it private; we only receive the draw ticket.
        ticket = await beginLotteryDraw(supabase, eventId);
        savePendingDraw(eventId, ticket);
        setServerDrawing(true);
      } else {
        const selection = selectWinner(data.participants, data.overrideParticipantId, data.overrideActivated, data.excludedParticipantIds);
        local = { participant: data.participants[selection.index], mode: selection.mode, ticketNumber: selection.index + 1 };
        ticket = {
          drawId: crypto.randomUUID(),
          startedAt: new Date().toISOString(),
          durationMs: data.settings.duration * 1000,
        };
        channelRef.current?.postMessage({
          sender: tabId.current, type: "draw", busy: true, startedAt: ticket.startedAt, durationMs: ticket.durationMs,
        });
      }
    } catch (error) {
      localDrawRef.current = false;
      setBusy(false);
      notify(errorText(error, "The draw could not be started."), "error");
      return;
    }
    await runDraw(ticket, local, false);
  };

  useEffect(() => {
    if (!resumeTicket || !ready || localDrawRef.current) return;
    const ticket = resumeTicket;
    setResumeTicket(null);
    void runDraw(ticket, null, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeTicket, ready]);

  const retryFinish = async () => {
    if (!recovery || busy) return;
    localDrawRef.current = true;
    setBusy(true);
    try {
      applyOutcome(await resolveDraw(recovery.ticket, null));
    } catch (error) {
      handleFinishFailure(recovery.ticket, error);
    } finally {
      localDrawRef.current = false;
      setBusy(false);
    }
  };

  const cancelStuckDraw = async () => {
    if (!supabase || !eventId || !isOperator) return;
    if (!window.confirm("Cancel the draw that is in progress? No winner will be recorded.")) return;
    try {
      await cancelLotteryDraw(supabase, eventId);
      setServerDrawing(false);
      abortRemotePresentation();
      notify("The draw in progress was cancelled.");
    } catch (error) {
      notify(errorText(error, "The draw could not be cancelled."), "error");
    }
  };

  // ----- participants ------------------------------------------------------------------------------------------------
  const updateSharedParticipants = async (action: ParticipantAction, participantId?: string, name?: string) => {
    if (!supabase || !eventId) throw new Error("Shared participant management is unavailable for this event.");
    setImportPending(true);
    try {
      adoptServerData(await manageLotteryParticipants(supabase, eventId, action, participantId, name));
    } finally {
      setImportPending(false);
    }
  };

  const addParticipant = async () => {
    if (drawLocked || rosterLocked) return;
    const name = newName.trim();
    if (!name) return;
    if (!isOperator && newNameAlreadyExists) {
      notify("That participant name is already in the draw.", "error");
      return;
    }
    if (useRpcRoster) {
      try {
        await updateSharedParticipants("add", undefined, name);
      } catch (error) {
        notify(errorText(error, "The participant could not be added."), "error");
        return;
      }
    } else {
      setData((current) => ({ ...current, participants: [...current.participants, makeParticipant(name)] }));
    }
    setNewName("");
    notify(`${name} added to the draw.`);
  };

  const removeParticipant = async (id: string) => {
    if (drawLocked || rosterLocked) return false;
    if (useRpcRoster) {
      try {
        await updateSharedParticipants("remove", id);
        return true;
      } catch (error) {
        notify(errorText(error, "The participant could not be removed."), "error");
        return false;
      }
    }
    if (dataRef.current.overrideParticipantId === id) commitOverride(null, false);
    setData((current) => ({ ...current, participants: current.participants.filter((person) => person.id !== id) }));
    return true;
  };

  const clearParticipants = () => {
    if (drawLocked || rosterLocked || data.participants.length === 0) return;
    const count = data.participants.length;
    if (!window.confirm(`Clear all ${count} participant${count === 1 ? "" : "s"} from the draw? Winner history will be kept.`)) return;
    void (async () => {
      if (useRpcRoster) {
        try {
          await updateSharedParticipants("clear");
        } catch (error) {
          notify(errorText(error, "Participants could not be cleared."), "error");
          return;
        }
      } else {
        if (dataRef.current.overrideParticipantId) commitOverride(null, false);
        setData((current) => ({ ...current, participants: [] }));
      }
      notify(`Cleared ${count} participant${count === 1 ? "" : "s"} from the draw.`);
    })();
  };

  const removeDuplicateParticipantsFromList = async () => {
    const duplicateCount = duplicateParticipantIds.size;
    if (drawLocked || rosterLocked || duplicateCount === 0) return;
    if (useRpcRoster) {
      try {
        await updateSharedParticipants("deduplicate");
      } catch (error) {
        notify(errorText(error, "Duplicate participants could not be removed."), "error");
        return;
      }
    } else {
      const current = dataRef.current;
      const participants = removeDuplicateParticipants(current.participants);
      if (current.overrideParticipantId && !participants.some((person) => person.id === current.overrideParticipantId)) commitOverride(null, false);
      setData((state) => ({ ...state, participants }));
    }
    notify(`Removed ${duplicateCount} duplicate participant entr${duplicateCount === 1 ? "y" : "ies"}.`);
  };

  const verifyParticipantNames = () => {
    if (duplicateParticipantIds.size === 0) {
      notify("Verified: no duplicate participant names found.");
    } else {
      notify(`Found ${duplicateParticipantIds.size} duplicate participant entr${duplicateParticipantIds.size === 1 ? "y" : "ies"}.`, "error");
    }
  };

  const updateParticipant = (id: string, changes: Partial<Participant>) => {
    if (drawLocked) return;
    setData((current) => ({
      ...current,
      participants: current.participants.map((person) => person.id === id ? { ...person, ...changes } : person),
    }));
  };

  // ----- spreadsheet import / export -------------------------------------------------------------------------------
  const loadWorkbook = async (file: File) => {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      if (workbook.SheetNames.length === 0) throw new Error("This file does not contain a worksheet.");
      const rows = Object.fromEntries(workbook.SheetNames.map((name) => [
        name,
        XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: "", raw: false }) as unknown[][],
      ]));
      setImportBook(workbook);
      setImportFileName(file.name);
      setSheetRows(rows);
      setSheetName(workbook.SheetNames[0]);
      setColumnIndex(0);
      setWeightColumn(-1);
      setImportAction("append");
      setKeepDuplicates(isOperator);
      setDialog("import");
    } catch (error) {
      notify(errorText(error, "Could not read this spreadsheet."), "error");
    }
  };

  const importRows = useMemo(() => {
    if (!importBook || !sheetName) return { columns: [] as string[], entries: [] as ImportEntry[], empty: 0, missing: 0, badWeights: 0 };
    const rows = sheetRows[sheetName] ?? [];
    const first = rows[0] ?? [];
    const columns = first.map((value, index) => {
      const label = String(value ?? "").trim();
      return label || `Column ${index + 1}`;
    });
    const start = hasHeader ? 1 : 0;
    const dataRows = rows.slice(start);
    const nonEmptyRows = dataRows.filter((row) => row.some((value) => String(value ?? "").trim()));
    let badWeights = 0;
    const entries: ImportEntry[] = [];
    for (const row of nonEmptyRows) {
      const name = String(row[columnIndex] ?? "").trim().slice(0, 100);
      if (!name) continue;
      let weight = 1;
      if (weightColumn >= 0) {
        const parsed = Number(String(row[weightColumn] ?? "").trim());
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) weight = parsed;
        else badWeights += 1;
      }
      entries.push({ name, weight });
    }
    return { columns, entries, empty: dataRows.length - nonEmptyRows.length, missing: nonEmptyRows.length - entries.length, badWeights };
  }, [importBook, sheetRows, sheetName, columnIndex, weightColumn, hasHeader]);
  const importDuplicateCount = useMemo(() => {
    const seen = new Set(importAction === "append"
      ? data.participants.map((participant) => normalizeParticipantName(participant.name))
      : []);
    let duplicates = 0;
    for (const { name } of importRows.entries) {
      const normalized = normalizeParticipantName(name);
      if (seen.has(normalized)) duplicates += 1;
      else seen.add(normalized);
    }
    return duplicates;
  }, [data.participants, importAction, importRows.entries]);

  const confirmImport = async () => {
    if (drawLocked || rosterLocked) return;
    let entries = importRows.entries;
    const preserveDuplicates = canEditEvent && keepDuplicates;
    if (!preserveDuplicates) {
      const seen = new Set(importAction === "append"
        ? data.participants.map((participant) => normalizeParticipantName(participant.name))
        : []);
      entries = entries.filter(({ name }) => {
        const key = normalizeParticipantName(name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (entries.length === 0) {
      notify("No new participants were added because every name already exists.", "error");
      return;
    }
    setImportPending(true);
    try {
      if (supabase && eventId) {
        // Large spreadsheets are sent in chunks of 2000 names so each database call stays fast.
        const CHUNK = 2000;
        for (let start = 0; start < entries.length; start += CHUNK) {
          const chunk = entries.slice(start, start + CHUNK);
          adoptServerData(await importLotteryParticipants(supabase, eventId, {
            names: chunk.map((entry) => entry.name),
            weights: weightColumn >= 0 && canEditEvent ? chunk.map((entry) => entry.weight) : undefined,
            action: start === 0 ? importAction : "append",
            keepDuplicates: preserveDuplicates,
          }));
        }
      } else {
        const incoming = entries.map((entry) => makeParticipant(entry.name, canEditEvent ? entry.weight : 1));
        if (importAction === "replace" && dataRef.current.overrideParticipantId) commitOverride(null, false);
        setData((current) => ({
          ...current,
          participants: importAction === "replace" ? incoming : [...current.participants, ...incoming],
        }));
      }
    } catch (error) {
      notify(errorText(error, "The spreadsheet participants could not be imported."), "error");
      return;
    } finally {
      setImportPending(false);
    }
    const skipped = importRows.entries.length - entries.length;
    notify(`Imported ${entries.length} participant${entries.length === 1 ? "" : "s"}${skipped ? `; skipped ${skipped} duplicate name${skipped === 1 ? "" : "s"}` : ""}.`);
    setDialog(null);
    setImportBook(null);
    setImportFileName("");
  };

  const exportParticipants = async () => {
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.json_to_sheet(data.participants.map(({ id, name, weight }) => ({ ID: id, Name: name, Weight: weight })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Participants");
    XLSX.writeFile(book, "lottery-ball-participants.xlsx");
  };

  const exportHistory = async () => {
    const XLSX = await import("xlsx");
    const sheet = XLSX.utils.json_to_sheet(winnersInDrawOrder(data.winners).map(({ participant, drawNumber, ticketNumber, timestamp, mode }) => ({
      "Draw order": drawNumber, "Participant number": ticketNumber, Name: participant.name,
      Date: new Date(timestamp).toLocaleString(),
      // how the winner was chosen is shown to the operator only
      ...(isOperator ? { Mode: mode } : {}),
    })));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Winner history");
    XLSX.writeFile(book, "lottery-ball-history.xlsx");
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lottery-ball-backup.json";
    link.click();
    URL.revokeObjectURL(link.href);
    notify("Session backup downloaded.");
  };

  const importBackup = async (file: File) => {
    if (drawLocked) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const restored = validateData(parsed);
      if (!window.confirm("Replace your current participants, settings, and winner history with this backup?")) return;
      setData(restored);
      commitOverride(restored.overrideParticipantId, restored.overrideActivated);
      commitExcluded(restored.excludedParticipantIds);
      setLastWinner(null);
      setCustomPalette(restored.settings.colors.join(", "));
      notify("Backup restored.");
    } catch (error) {
      notify(errorText(error, "The backup could not be restored."), "error");
    }
  };

  const resetSession = () => {
    if (drawLocked) return;
    if (!window.confirm("Reset participants, winner history, and lottery settings? This cannot be undone.")) return;
    setData(structuredClone(DEFAULT_DATA));
    commitOverride(null, false);
    commitExcluded([]);
    setLastWinner(null);
    setCustomPalette(DEFAULT_SETTINGS.colors.join(", "));
    notify("Session reset.");
  };

  const clearWinnerHistory = () => {
    if (drawLocked || data.winners.length === 0) return;
    if (!window.confirm("Clear all winner history? Participants already removed from the draw will remain removed.")) return;
    setData((current) => ({ ...current, winners: [] }));
    setLastWinner(null);
    lastWinnerKeyRef.current = null;
    notify("Winner history cleared.");
  };

  const restoreWinner = (id: string) => {
    if (drawLocked) return;
    const record = data.winners.find((entry) => entry.participant.id === id);
    if (!record || data.participants.some((person) => person.id === id)) return;
    setData((current) => ({ ...current, participants: [...current.participants, record.participant] }));
    notify(`${record.participant.name} restored to the draw.`);
  };

  // ----- operator account and events ---------------------------------------------------------------------------------
  const sendMagicLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !authEmail.trim()) return;
    setOperationPending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: authEmail.trim(),
        options: { emailRedirectTo: window.location.href },
      });
      if (error) throw error;
      setMagicLinkSent(true);
    } catch (error) {
      notify(errorText(error, "The sign-in email could not be sent."), "error");
    } finally {
      setOperationPending(false);
    }
  };

  const operatorUrl = (id: string) => {
    const url = new URL(import.meta.env.BASE_URL, window.location.origin);
    url.searchParams.set("view", "operator");
    url.searchParams.set("event", id);
    return url;
  };

  const createSharedEvent = async () => {
    if (!supabase || !session) return;
    setOperationPending(true);
    try {
      window.location.assign(operatorUrl(await createLotteryEvent(supabase, session.user.id)));
    } catch (error) {
      notify(errorText(error, "The shared event could not be created."), "error");
    } finally {
      setOperationPending(false);
    }
  };

  useEffect(() => {
    if (!supabase || !isOperator || !session || eventId) return;
    const client = supabase;
    let active = true;
    listOwnedEvents(client, session.user.id)
      .then((events) => { if (active) setOwnedEvents(events); })
      .catch((error: unknown) => { if (active) setStorageError(errorText(error, "Your events could not be loaded.")); });
    return () => { active = false; };
  }, [isOperator, session, eventId]);

  const removeOwnedEvent = async (summary: OwnedEventSummary) => {
    if (!supabase || !session) return;
    if (!window.confirm(`Delete "${summary.title}" with its ${summary.participantCount} participants and ${summary.winnerCount} winners? This cannot be undone.`)) return;
    try {
      await deleteLotteryEvent(supabase, summary.id, session.user.id);
      setOwnedEvents((events) => events.filter((entry) => entry.id !== summary.id));
      notify("Event deleted.");
    } catch (error) {
      notify(errorText(error, "The event could not be deleted."), "error");
    }
  };

  const signOutOperator = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) notify(error.message, "error");
    else setSession(null);
  };

  const sharedUrl = (operatorView: boolean) => {
    const url = new URL(import.meta.env.BASE_URL, window.location.origin);
    if (eventId) url.searchParams.set("event", eventId);
    if (operatorView) url.searchParams.set("view", "operator");
    return url.toString();
  };

  const copySharedLink = async (operatorView: boolean) => {
    try {
      await navigator.clipboard.writeText(sharedUrl(operatorView));
      notify(`${operatorView ? "Operator" : "Audience"} link copied.`);
    } catch (error) {
      notify(errorText(error, "Could not copy the link."), "error");
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      notify(errorText(error, "Fullscreen mode could not be changed."), "error");
    }
  };

  useEffect(() => {
    const list = winnerListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [data.winners.length]);

  const filteredWinners = winnersInDrawOrder(data.winners).filter((record) =>
    record.participant.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  // ----- screens ------------------------------------------------------------------------------------------------------
  if (supabaseConfigurationError) {
    return <main className="cloud-shell"><section className="cloud-panel">
      <div className="brand-mark"><CircleHelp size={20} /></div>
      <div className="eyebrow">APP CONFIGURATION</div>
      <h1>Supabase setup needs attention</h1>
      <p role="alert">{supabaseConfigurationError}</p>
    </section></main>;
  }
  if (supabase && isOperator && authLoading) {
    return <main className="loading-screen"><LoaderCircle className="spin-loader" /><span>Checking operator sign-in…</span></main>;
  }
  if (supabase && isOperator && !session) {
    return <main className="cloud-shell"><section className="cloud-panel">
      <div className="brand-mark"><LockKeyhole size={20} /></div>
      <div className="eyebrow">OPERATOR ACCESS</div>
      <h1>Sign in to manage your lottery</h1>
      {magicLinkSent ? <p>Check your inbox for a secure sign-in link. Open it on this device to continue.</p> :
        <form className="cloud-form" onSubmit={(event) => void sendMagicLink(event)}>
          <label className="setting-field"><span>Email address</span><input type="email" autoComplete="email" required value={authEmail}
            onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@example.com" /></label>
          <button className="button button-primary" disabled={operationPending || !authEmail.trim()}>
            {operationPending ? "Sending link…" : "Email me a sign-in link"}
          </button>
        </form>}
      {storageError && <p className="cloud-error" role="alert">{storageError}</p>}
      <a className="cloud-back-link" href={import.meta.env.BASE_URL}>Return to audience screen</a>
    </section></main>;
  }
  if (supabase && isOperator && session && !eventId) {
    return <main className="cloud-shell"><section className="cloud-panel cloud-panel-wide">
      <div className="brand-mark"><Sparkles size={20} /></div>
      <div className="eyebrow">SHARED EVENTS</div>
      <h1>Your lottery events</h1>
      <p>Create an event to get shareable audience and operator links. This signed-in account owns its operator controls.</p>
      {storageError && <p className="cloud-error" role="alert">{storageError}</p>}
      <button className="button button-primary" disabled={operationPending} onClick={() => void createSharedEvent()}>
        <Plus size={15} /> {operationPending ? "Creating event…" : "Create event"}
      </button>
      {ownedEvents.length > 0 && <ul className="event-list">{ownedEvents.map((entry) => <li key={entry.id}>
        <div><strong>{entry.title}</strong><small>{entry.participantCount} participants · {entry.winnerCount} winners · updated {new Date(entry.updatedAt).toLocaleString()}</small></div>
        <a className="button button-outline" href={operatorUrl(entry.id).toString()}>Open</a>
        <button className="icon-button danger-icon" aria-label={`Delete ${entry.title}`} onClick={() => void removeOwnedEvent(entry)}><Trash2 size={15} /></button>
      </li>)}</ul>}
      <button className="text-button cloud-signout" onClick={() => void signOutOperator()}>Sign out ({session.user.email})</button>
    </section></main>;
  }
  if (supabase && !isOperator && !eventId) {
    return <main className="cloud-shell"><section className="cloud-panel">
      <div className="brand-mark"><Sparkles size={20} /></div>
      <div className="eyebrow">AUDIENCE SCREEN</div>
      <h1>Open a shared lottery</h1>
      <p>Use the audience link shared by the event operator to join the live drawing.</p>
      <a className="button button-outline" href={`${import.meta.env.BASE_URL}?view=operator`}>Operator sign-in</a>
    </section></main>;
  }
  if (supabase && eventId && ready && !eventOwnerId) {
    return <main className="cloud-shell"><section className="cloud-panel">
      <div className="brand-mark"><CircleHelp size={20} /></div>
      <div className="eyebrow">SHARED EVENT</div>
      <h1>Could not open this lottery</h1>
      <p role="alert">{storageError || "The event is unavailable. Check the link and try again."}</p>
      <a className="button button-outline" href={import.meta.env.BASE_URL}>Return to home</a>
    </section></main>;
  }
  if (supabase && isOperator && eventOwnerId && eventOwnerId !== session?.user.id) {
    return <main className="cloud-shell"><section className="cloud-panel">
      <div className="brand-mark"><LockKeyhole size={20} /></div>
      <div className="eyebrow">OPERATOR ACCESS</div>
      <h1>This event belongs to another account</h1>
      <p>Sign in with the account that created this lottery event.</p>
      <button className="button button-outline" onClick={() => void signOutOperator()}>Sign out</button>
    </section></main>;
  }
  if (storageError && !ready) {
    return <main className="fatal-screen"><ShieldCheck size={42} /><h1>Could not open saved session</h1>
      <p>{storageError} The saved session may be invalid, or IndexedDB may be unavailable in this browser.</p>
      <button className="button button-primary" onClick={() => window.location.reload()}>Try again</button>
    </main>;
  }
  if (!ready) return <main className="loading-screen"><LoaderCircle className="spin-loader" /><span>Opening your lottery…</span></main>;

  const machine = <div className="machine-stage">
    <LotteryMachine phase={machinePhase} ballLabel={formatTicket(ballNumber)} ballColor={ballColor}
      colors={data.settings.colors}
      participantCount={data.participants.length} onRevealComplete={handleRevealComplete} />
    <div className={`draw-status${drawActive ? " is-active" : ""}`} role="status" aria-live="polite">{drawStatus}</div>
  </div>;

  const recoveryNotice = recovery && <div className="recovery-notice" role="alert">
    <span>The balls have been drawn, but the result could not be confirmed ({recovery.message}). Nothing is lost: retry to reveal the winner.</span>
    <button className="button button-primary" disabled={busy} onClick={() => void retryFinish()}><RotateCcw size={14} /> Retry</button>
  </div>;

  const winnerOverlay = lastWinner && <WinnerAnnouncement winner={lastWinner} confetti={data.settings.confetti}
    autoRemove={data.settings.autoRemove} colors={data.settings.colors} ballColor={ballColorFor(data.settings.colors, lastWinner.ticketNumber)} onClose={continueFromWinner} />;

  const toastStack = <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}>
    {toast.tone === "success" ? <Check size={16} /> : <CircleHelp size={16} />}{toast.message}
  </div>)}</div>;

  const musicButton = <button className="icon-button" title={drawMusicEnabled ? "Mute draw music" : "Enable draw music"}
    aria-label={drawMusicEnabled ? "Mute draw music" : "Enable draw music"} aria-pressed={drawMusicEnabled} onClick={toggleMusic}>
    {drawMusicEnabled ? <Music size={18} /> : <VolumeX size={18} />}
  </button>;

  const fullscreenButton = <button className="icon-button" title="Fullscreen" aria-label="Fullscreen" onClick={() => void toggleFullscreen()}>
    <Fullscreen size={18} /></button>;

  const dialogs = dialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setDialog(null); setCapturingShortcut(false); } }}>
    <section className={`dialog ${dialog === "participants" || dialog === "history" ? "dialog-wide" : ""}`} role="dialog" aria-modal="true">
      <header className="dialog-header"><div><span className="eyebrow">LOTTERY / BALL</span>
        <h2>{dialog === "participants" ? "Participants" : dialog === "import" ? "Import spreadsheet" : dialog === "settings" ? "Lottery settings" : "Winner history"}</h2></div>
        <button className="icon-button" aria-label="Close dialog" onClick={() => { setDialog(null); setCapturingShortcut(false); }}><X size={18} /></button>
      </header>

      {dialog === "participants" && <div className="dialog-content">
        {rosterLocked && <p className="duplicate-input-note" role="status">The operator has locked the participant list for this event.</p>}
        <div className="add-participant">
          <input value={newName} disabled={drawLocked || rosterLocked} maxLength={100} placeholder="Add a participant name…" onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void addParticipant(); }} />
          <button className="button button-primary" onClick={() => void addParticipant()} disabled={drawLocked || rosterLocked || !newName.trim() || newNameAlreadyExists}><Plus size={16} /> Add</button>
        </div>
        {newNameAlreadyExists && <p className="duplicate-input-note" role="alert">That name is already in the draw.</p>}
        <div className="list-toolbar"><span>{data.participants.length} active participant{data.participants.length === 1 ? "" : "s"}</span>
          <div className="participant-file-actions">
            <button className="button button-outline" type="button" disabled={drawLocked || rosterLocked || !data.participants.length}
              onClick={clearParticipants}><Trash2 size={14} /> Clear participants</button>
            <label className={`button button-outline file-button${drawLocked || rosterLocked ? " is-disabled" : ""}`}><Upload size={14} /> Import Excel
              <input type="file" accept=".xlsx,.xls,.csv" disabled={drawLocked || rosterLocked} aria-label="Import participants from an Excel file" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadWorkbook(file);
                event.target.value = "";
              }} />
            </label>
            <button className="text-button" onClick={() => void exportParticipants()} disabled={!data.participants.length}><Download size={14} /> Export</button>
          </div>
        </div>
        <div className={`duplicate-check${duplicateParticipantIds.size ? " has-duplicates" : ""}`} role="status">
          <span><ShieldCheck size={16} />{duplicateParticipantIds.size
            ? `${duplicateParticipantIds.size} duplicate participant entr${duplicateParticipantIds.size === 1 ? "y" : "ies"} found`
            : "No duplicate participant names detected"}</span>
          <div>
            <button className="text-button" type="button" onClick={verifyParticipantNames}><Check size={14} /> Verify names</button>
            <button className="text-button" type="button" disabled={drawLocked || rosterLocked || duplicateParticipantIds.size === 0}
              onClick={() => void removeDuplicateParticipantsFromList()}><Trash2 size={14} /> Remove duplicates</button>
          </div>
        </div>
        {data.participants.length === 0 ? <div className="empty-state"><FileSpreadsheet size={22} /><p>No participants yet. Add names or import a spreadsheet.</p></div> :
          <div className="participant-list">{data.participants.map((person, index) => <div className="participant-row" key={person.id}>
            <span className="row-index">{String(index + 1).padStart(2, "0")}</span>
            {isOperator ? <>
              <input aria-label={`Participant ${index + 1} name`} value={person.name} maxLength={100} disabled={drawLocked}
                onChange={(event) => updateParticipant(person.id, { name: event.target.value })} />
              <input className="weight-input" type="number" min="0.01" max="1000" step="any" aria-label={`Weight for ${person.name}`} title="Draw weight (1 = normal)"
                value={person.weight} disabled={drawLocked}
                onChange={(event) => { const weight = Number(event.target.value); if (Number.isFinite(weight) && weight > 0 && weight <= 1000) updateParticipant(person.id, { weight }); }} />
            </> : <span className="participant-row-name">{person.name}{person.weight > 1 && <small> ×{person.weight}</small>}</span>}
            {isOperator && <button className={`icon-button exclude-icon${excludedSet.has(person.id) ? " is-on" : ""}`} disabled={drawLocked}
              title={excludedSet.has(person.id) ? "Excluded from the random draw. Click to include again" : "Exclude from the random draw"}
              aria-label={`${excludedSet.has(person.id) ? "Include" : "Exclude"} ${person.name} ${excludedSet.has(person.id) ? "in" : "from"} the random draw`}
              aria-pressed={excludedSet.has(person.id)} onClick={() => toggleExcluded(person.id)}><EyeOff size={15} /></button>}
            <button className="icon-button danger-icon" aria-label={`Remove ${person.name}`} disabled={drawLocked || rosterLocked} onClick={() => void removeParticipant(person.id)}><Trash2 size={15} /></button>
          </div>)}</div>}
        <p className="dialog-note">{isOperator
          ? "Names are identified by participant ID. A weight of 2 makes a participant twice as likely to be drawn. Use the duplicate check to clean repeated names."
          : "Add participants by name or spreadsheet. New names are checked against the current list, ignoring letter case."}</p>
      </div>}

      {dialog === "import" && <div className="dialog-content">
        {!importBook ? <div className="empty-state"><Upload size={22} /><p>Select an XLSX, XLS, or CSV file to begin.</p></div> : <>
          <div className="file-summary"><FileSpreadsheet size={19} /><strong>{importFileName || "Spreadsheet loaded"}</strong><span>{importBook.SheetNames.length} sheet{importBook.SheetNames.length === 1 ? "" : "s"}</span></div>
          {importBook.SheetNames.length > 1 && <label className="setting-field"><span>Worksheet</span><select value={sheetName} onChange={(event) => { setSheetName(event.target.value); setColumnIndex(0); setWeightColumn(-1); }}>
            {importBook.SheetNames.map((name) => <option key={name}>{name}</option>)}</select></label>}
          <label className="setting-field"><span>Name column</span><select value={columnIndex} onChange={(event) => setColumnIndex(Number(event.target.value))}>
            {(importRows.columns.length ? importRows.columns : ["No columns found"]).map((label, index) => <option key={`${label}-${index}`} value={index}>{label}</option>)}</select></label>
          {canEditEvent && <label className="setting-field"><span>Weight column <small>optional · positive numbers, default 1</small></span><select value={weightColumn} onChange={(event) => setWeightColumn(Number(event.target.value))}>
            <option value={-1}>None (everyone has weight 1)</option>
            {importRows.columns.map((label, index) => <option key={`${label}-${index}`} value={index}>{label}</option>)}</select></label>}
          <label className="check-setting"><input type="checkbox" checked={hasHeader} onChange={(event) => setHasHeader(event.target.checked)} /><span>First row contains column headers</span></label>
          {canEditEvent && <label className="check-setting"><input type="checkbox" checked={keepDuplicates} onChange={(event) => setKeepDuplicates(event.target.checked)} /><span>Keep duplicate names as separate entries</span></label>}
          <div className="import-preview"><div className="preview-heading"><span>PREVIEW</span><strong>{importRows.entries.length} names · {importRows.empty} blank rows · {importRows.missing} rows without a name</strong></div>
            {importRows.entries.length === 0 ? <p>No names found in the selected column.</p> :
              <div className="preview-names">{importRows.entries.slice(0, 12).map((entry, index) => <span key={`${entry.name}-${index}`}>{entry.name}{entry.weight !== 1 && ` ×${entry.weight}`}</span>)}{importRows.entries.length > 12 && <span>+{importRows.entries.length - 12} more</span>}</div>}
            {importDuplicateCount > 0 && <p className="duplicate-note">{importDuplicateCount} repeated name{importDuplicateCount === 1 ? "" : "s"} detected. {canEditEvent && keepDuplicates ? "They will be kept as separate participants." : "Repeated names will be skipped."}</p>}
            {importRows.badWeights > 0 && <p className="duplicate-note">{importRows.badWeights} row{importRows.badWeights === 1 ? " has" : "s have"} an invalid weight and will use 1.</p>}
          </div>
          <fieldset className="import-choice"><legend>Import action</legend>
            <label><input type="radio" name="import-action" checked={importAction === "append"} onChange={() => setImportAction("append")} /> Add to current participants</label>
            <label><input type="radio" name="import-action" checked={importAction === "replace"} onChange={() => setImportAction("replace")} /> Replace current participants</label>
          </fieldset>
          <div className="dialog-actions"><button className="button button-outline" onClick={() => setDialog(null)}>Cancel</button>
            <button className="button button-primary" onClick={() => void confirmImport()} disabled={drawLocked || rosterLocked || !importRows.entries.length}><Upload size={15} /> Import {importRows.entries.length} names</button></div>
        </>}
      </div>}

      {dialog === "settings" && <div className="dialog-content settings-content">
        <fieldset className="settings-fields" disabled={drawLocked}>
          <label className="setting-field"><span>Event title</span><input maxLength={60} value={data.settings.title} onChange={(event) => updateSettings({ title: event.target.value })} /></label>
          <label className="setting-field"><span>Drawing duration <small>seconds the balls are mixed before the reveal ({MIN_DURATION_SECONDS}–{MAX_DURATION_SECONDS})</small></span>
            <input type="number" min={MIN_DURATION_SECONDS} max={MAX_DURATION_SECONDS} value={data.settings.duration}
              onChange={(event) => updateSettings({ duration: Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, Math.round(Number(event.target.value)) || MIN_DURATION_SECONDS)) })} /></label>
          <label className="setting-field"><span>Ball colors <small>comma-separated hex values</small></span><input value={customPalette}
            onChange={(event) => setCustomPalette(event.target.value)} onBlur={() => {
              const colors = customPalette.split(",").map((color) => color.trim()).filter((color) => /^#[0-9a-f]{6}$/i.test(color));
              if (!colors.length) { setCustomPalette(data.settings.colors.join(", ")); notify("Enter at least one valid six-digit hex color.", "error"); }
              else updateSettings({ colors });
            }} placeholder="#e63946, #2a6fdb, #f4c430" /></label>
          <div className="color-swatches">{data.settings.colors.map((color) => <span key={color} title={color} style={{ background: color }} />)}</div>
          <label className="check-setting"><input type="checkbox" checked={data.settings.autoRemove} onChange={(event) => updateSettings({ autoRemove: event.target.checked })} /><span>Remove each winner from the active draw</span></label>
          <label className="check-setting"><input type="checkbox" checked={data.settings.confetti} onChange={(event) => updateSettings({ confetti: event.target.checked })} /><span>Celebrate winners with confetti</span></label>
          <label className="check-setting"><input type="checkbox" checked={data.settings.sound} onChange={(event) => updateSettings({ sound: event.target.checked })} /><span>Play sound effects</span></label>
          {isOperator && supabase && <>
            <label className="check-setting"><input type="checkbox" checked={data.settings.audienceCanDraw} onChange={(event) => updateSettings({ audienceCanDraw: event.target.checked })} /><span>Allow anyone with the audience link to start a draw</span></label>
            <label className="check-setting"><input type="checkbox" checked={data.settings.audienceCanManageRoster} onChange={(event) => updateSettings({ audienceCanManageRoster: event.target.checked })} /><span>Allow anyone with the audience link to add, import and remove participants</span></label>
          </>}
          {isOperator && <div className="shortcut-setting"><div><strong>Desktop shortcut (optional)</strong><span>You can also activate a one-time pick with the button on the draw controls.</span></div>
            <button className="button button-outline shortcut-button" onClick={() => setCapturingShortcut(true)}>
              {capturingShortcut ? "Press a letter or number…" : <><Keyboard size={15} /> {keyLabel(data.settings.shortcut)}</>}
            </button></div>}
          {isOperator && <>
            <div className="security-note"><LockKeyhole size={15} /><span>{supabase
              ? "The predetermined winner is stored privately in the database and is never sent to audience screens."
              : "Data stays in this browser. As a client-only app, it cannot enforce administrator access."}</span></div>
            <div className="backup-actions"><button className="button button-outline" onClick={exportBackup}><Download size={15} /> Backup</button>
              <button className="button button-outline" onClick={() => backupInput.current?.click()}><Upload size={15} /> Restore backup</button>
              <input ref={backupInput} className="hidden-input" type="file" accept=".json,application/json" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importBackup(file);
                event.target.value = "";
              }} />
              <button className="button button-danger" onClick={resetSession}><RotateCcw size={14} /> Reset session</button></div>
          </>}
          <button className="button button-primary settings-done" onClick={() => { setDialog(null); setCapturingShortcut(false); }}><Check size={15} /> Done</button>
        </fieldset>
      </div>}

      {dialog === "history" && <div className="dialog-content">
        <div className="history-toolbar"><label className="search-field"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search winners…" /><span>⌕</span></label>
          <button className="button button-outline" onClick={() => void exportHistory()} disabled={!data.winners.length}><Download size={14} /> Export Excel</button></div>
        {filteredWinners.length === 0 ? <div className="empty-state"><Trophy size={22} /><p>{data.winners.length ? "No winners match your search." : "Winner history will appear here after the first draw."}</p></div> :
          <div className="history-list">{filteredWinners.map((record) => {
            const isActive = data.participants.some((person) => person.id === record.participant.id);
            return <div className="history-row" key={`${record.drawNumber}-${record.participant.id}-${record.timestamp}`}>
              <span className="history-rank" title="Draw order">{record.drawNumber}</span>
              <span className={`mini-ball digits-${Math.min(3, String(record.ticketNumber).length)}`} title="Participant number"
                style={{ ["--ball-color" as string]: ballColorFor(data.settings.colors, record.ticketNumber) }}><b>{formatTicket(record.ticketNumber)}</b></span>
              <div className="history-person"><strong>{record.participant.name}</strong><span>{formatWinnerTime(record.timestamp)}</span></div>
              {isOperator && <span className={`mode-pill mode-${record.mode}`}>{modeLabel(record.mode)}</span>}
              {canEditEvent && !isActive && <button className="icon-button restore-icon" disabled={drawLocked} title="Restore to draw" aria-label={`Restore ${record.participant.name}`} onClick={() => restoreWinner(record.participant.id)}><RotateCcw size={15} /></button>}
            </div>;
          })}</div>}
        <div className="dialog-actions history-actions">
          {canEditEvent && <button className="button button-danger" disabled={drawLocked || !data.winners.length}
            onClick={clearWinnerHistory}><Trash2 size={14} /> Clear history</button>}
          <button className="button button-outline" onClick={() => setDialog(null)}>Close</button>
        </div>
      </div>}
    </section>
  </div>;

  // ----- audience screen ------------------------------------------------------------------------------------------------
  if (!isOperator) {
    return <main className="public-shell">
      {storageError && <div className="storage-warning" role="alert">{storageError}</div>}
      <header className="public-topbar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={20} /></span>
          <span>LUCKY<span className="brand-muted"> / DRAW</span></span>
        </div>
        <div className="public-top-actions">
          {musicButton}
          {(!supabase || isOwner) && <button className="button button-outline" disabled={drawLocked} onClick={() => setDialog("settings")}><Settings2 size={16} /> Settings</button>}
          {fullscreenButton}
        </div>
      </header>
      <section className="public-heading">
        <div className="eyebrow"><span className="live-dot" /> LIVE DRAW</div>
        <h1>{data.settings.title || "THE GRAND DRAW"}</h1>
      </section>
      <section className="public-content">
        <div className="public-game">
          {machine}
          <button className="draw-button" disabled={drawLocked || !canDraw || data.participants.length === 0} onClick={() => void startDraw()}>
            {drawLocked ? <><LoaderCircle className="button-spinner" size={19} /> DRAWING</> : <><Sparkles size={18} /> DRAW A WINNER</>}
          </button>
          {!canDraw && <div className="spin-caption"><LockKeyhole size={11} /> The operator controls this draw</div>}
          {recoveryNotice}
          <div className="public-stats"><span><strong>{data.participants.length}</strong> participants</span><i />
            <span><strong>{data.winners.length}</strong> winners drawn</span></div>
          {data.winners[0] && machinePhase !== "mixing" && machinePhase !== "revealing" && <div className="public-latest">
            <Trophy size={15} /><span>Latest winner: <strong>{data.winners[0].participant.name}</strong></span>
          </div>}
        </div>
        <aside className="public-details">
          <section className="public-detail-card">
            <div className="public-card-heading"><div><span className="card-overline">IN THE MACHINE</span><h2>Participants</h2></div>
              <span className="public-count">{data.participants.length}</span></div>
            {data.participants.length === 0 ? <p className="public-empty-copy">Add names to see them here and in the machine.</p> :
              <ul className="public-participant-list">{data.participants.map((person, index) => <li key={person.id}>
                <span className={`mini-ball mini-ball-sm digits-${Math.min(3, String(index + 1).length)}`}
                  style={{ ["--ball-color" as string]: ballColorFor(data.settings.colors, index + 1) }}><b>{formatTicket(index + 1)}</b></span>
                <span>{person.name}</span><small>{person.weight > 1 ? `×${person.weight}` : ""}</small>
              </li>)}</ul>}
            <div className="public-participant-actions">
              <button className="button button-quiet public-detail-action" disabled={drawLocked} onClick={() => setDialog("participants")}><ListPlus size={15} /> Manage participants</button>
            </div>
          </section>
          <section className="public-detail-card">
            <div className="public-card-heading"><div><span className="card-overline">DRAW RECORD</span><h2>Winner history</h2></div>
              <span className="public-count">{data.winners.length}</span></div>
            {data.winners.length === 0 ? <p className="public-empty-copy">Winners will appear here after the first draw.</p> :
              <ul className="public-winner-list" ref={winnerListRef}>{winnersInDrawOrder(data.winners).map((winner) => <li key={`${winner.drawNumber}-${winner.participant.id}-${winner.timestamp}`}>
                <span className="history-rank" title="Draw order">{winner.drawNumber}</span>
                <span className={`mini-ball digits-${Math.min(3, String(winner.ticketNumber).length)}`} title="Participant number"
                  style={{ ["--ball-color" as string]: ballColorFor(data.settings.colors, winner.ticketNumber) }}><b>{formatTicket(winner.ticketNumber)}</b></span>
                <div><strong>{winner.participant.name}</strong><small>{formatWinnerTime(winner.timestamp)}</small></div>
              </li>)}</ul>}
            {data.winners.length > 0 && <button className="button button-quiet public-detail-action" onClick={() => setDialog("history")}><History size={15} /> View all winners</button>}
          </section>
        </aside>
      </section>
      <footer className="public-footer">LUCKY DRAW - 2026</footer>
      {winnerOverlay}
      {dialogs}
      {toastStack}
    </main>;
  }

  // ----- operator console -------------------------------------------------------------------------------------------------
  return (
    <main className="app-shell">
      {storageError && <div className="storage-warning" role="alert">{storageError}</div>}
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL}>
          <span className="brand-mark"><Sparkles size={20} /></span><span>LOTTERY<span className="brand-muted"> / BALL</span></span>
        </a>
        <div className="topbar-actions">
          {supabase && eventId && <>
            <button className="button button-outline" onClick={() => void copySharedLink(false)}><Copy size={15} /> Audience link</button>
            <button className="button button-outline" onClick={() => void copySharedLink(true)}><Copy size={15} /> Operator link</button>
            <a className="button button-outline" href={`${import.meta.env.BASE_URL}?view=operator`}>All events</a>
          </>}
          <button className="button button-outline" onClick={() => window.open(supabase && eventId ? sharedUrl(false) : import.meta.env.BASE_URL, "_blank", "noopener,noreferrer")}>Open audience screen</button>
          {supabase && session && <button className="text-button" onClick={() => void signOutOperator()}>Sign out</button>}
          {musicButton}
          {fullscreenButton}
          <button className="button button-outline" disabled={drawLocked} onClick={() => setDialog("settings")}><Settings2 size={16} /> Settings</button>
        </div>
      </header>

      <section className="hero-heading">
        <div className="eyebrow"><span className="live-dot" /> LIVE DRAW</div>
        <h1>{data.settings.title || "THE GRAND DRAW"}</h1>
      </section>

      <section className="game-layout">
        <div className="machine-column">
          {machine}
          <div className="spin-controls">
            <button className="draw-button" disabled>
              <LockKeyhole size={16} /> Draw from the audience screen
            </button>
            <div className="spin-caption">OPEN THE AUDIENCE SCREEN TO START A DRAW</div>
            {serverDrawing && supabase && <button className="text-button" onClick={() => void cancelStuckDraw()}><Ban size={13} /> Cancel draw in progress</button>}
          </div>
        </div>

        <aside className="side-panel">
          <div className="panel-card draw-card">
            <div className="card-overline"><span>DRAW CONTROL</span><span>OPERATOR</span></div>
            <div className="normal-draw-label"><span>NORMAL DRAW</span><strong>{data.participants.some((person) => person.weight !== data.participants[0]?.weight) ? "Weighted random winner" : "Random winner"}</strong></div>
            <div className={`override-status ${data.overrideActivated ? "is-armed" : ""}`}>
              <Keyboard size={16} /><div><strong>{data.overrideActivated ? "One-time pick armed" : "One-time pick ready"}</strong>
                <span>{data.overrideParticipantId
                  ? `${selectedOverrideParticipant?.name ?? "Unavailable"}${data.overrideActivated ? " · will be selected on the next draw" : " · activate below to use on the next draw"}`
                  : "Search and select a participant below"}</span></div>
              {data.overrideActivated && <button className="text-button" disabled={drawLocked} onClick={() => {
                commitOverride(data.overrideParticipantId, false);
                notify("One-time pick cancelled.");
              }}>Cancel</button>}
            </div>
            <label className="field-label override-label" htmlFor="override-person">PREDETERMINED WINNER</label>
            <label className="override-search">
              <Search size={16} aria-hidden="true" />
              <input id="override-person" type="search" value={overrideSearch} disabled={drawLocked || data.participants.length === 0}
                onChange={(event) => setOverrideSearch(event.target.value)} placeholder="Search participants…" aria-label="Search participants for predetermined winner" />
            </label>
            {data.participants.length === 0 ? <p className="override-empty">Add participants before choosing a one-time pick.</p> :
              filteredOverrideParticipants.length === 0 ? <p className="override-empty">No participants match “{overrideSearch.trim()}”.</p> :
                <div className="override-participant-list" role="listbox" aria-label="Predetermined winner">
                  {filteredOverrideParticipants.map(({ participant, index }) => {
                    const selected = participant.id === data.overrideParticipantId;
                    return <button className={`override-participant${selected ? " is-selected" : ""}`} type="button" role="option"
                      aria-selected={selected} key={participant.id} disabled={drawLocked} onClick={() => commitOverride(participant.id, false)}>
                      <span className="override-participant-index">{index + 1}</span>
                      <span className="override-participant-name">{participant.name}</span>
                      {participant.weight !== 1 && <small>×{participant.weight}</small>}
                      {selected && <Check size={16} aria-hidden="true" />}
                    </button>;
                  })}
                </div>}
            <button className="button button-primary arm-button" type="button" disabled={drawLocked || !eligibleOverride || data.overrideActivated}
              onClick={activateOverride}>
              <Check size={15} />{data.overrideActivated ? "One-time pick is armed" : "Activate one-time pick"}
            </button>
            <div className="mode-note"><LockKeyhole size={13} /> How each winner was chosen is shown here in the operator console only, never to the audience.</div>
          </div>

          <div className="panel-card exclude-card">
            <div className="card-overline"><span>EXCLUDED FROM RANDOM DRAW</span><span>OPERATOR</span></div>
            <p className="exclude-help">Names you pick here cannot win the random draw. They stay on the list and in the machine, and become eligible again as soon as you remove them from this list.</p>
            <label className="override-search">
              <Search size={16} aria-hidden="true" />
              <input type="search" value={excludeSearch} disabled={drawLocked || data.participants.length === 0}
                onChange={(event) => setExcludeSearch(event.target.value)} placeholder="Search names to exclude…" aria-label="Search participants to exclude from the random draw" />
            </label>
            {data.participants.length === 0 ? <p className="override-empty">Add participants first.</p> :
              filteredExcludeParticipants.length === 0 ? <p className="override-empty">No participants match “{excludeSearch.trim()}”.</p> :
                <div className="override-participant-list exclude-pick-list" role="listbox" aria-multiselectable="true" aria-label="Participants to exclude from the random draw">
                  {filteredExcludeParticipants.map(({ participant, index }) => {
                    const excluded = excludedSet.has(participant.id);
                    return <button className={`override-participant${excluded ? " is-excluded" : ""}`} type="button" role="option"
                      aria-selected={excluded} key={participant.id} disabled={drawLocked} onClick={() => toggleExcluded(participant.id)}>
                      <span className="override-participant-index">{index + 1}</span>
                      <span className="override-participant-name">{participant.name}</span>
                      {excluded ? <EyeOff size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                    </button>;
                  })}
                </div>}
            <div className="exclude-actions">
              <button className="text-button" type="button" disabled={drawLocked || filteredExcludeParticipants.length === 0 || !excludeSearch.trim()}
                onClick={() => commitExcluded([...new Set([...data.excludedParticipantIds, ...filteredExcludeParticipants.map(({ participant }) => participant.id)])])}>
                <EyeOff size={13} /> Exclude all shown
              </button>
              <button className="text-button" type="button" disabled={drawLocked || data.excludedParticipantIds.length === 0}
                onClick={() => commitExcluded([])}><X size={13} /> Clear list</button>
            </div>
            <div className="exclude-summary"><strong>{excludedParticipants.length}</strong> excluded · <strong>{data.participants.length - excludedParticipants.length}</strong> can win the random draw</div>
            {excludedParticipants.length > 0 && <ul className="exclude-chips" aria-label="Excluded participants">
              {excludedParticipants.map(({ participant, index }) => <li key={participant.id}>
                <span className="exclude-chip-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="exclude-chip-name">{participant.name}</span>
                <button type="button" className="exclude-chip-remove" disabled={drawLocked} aria-label={`Remove ${participant.name} from the excluded list`}
                  onClick={() => toggleExcluded(participant.id)}><X size={13} /></button>
              </li>)}
            </ul>}
            <div className="mode-note"><LockKeyhole size={13} /> Private to you. The audience never sees this list.</div>
          </div>

          <div className="panel-card stats-card">
            <div className="stat-block"><span>IN THE MACHINE</span><strong>{data.participants.length}</strong><small>{excludedParticipants.length > 0 ? `${data.participants.length - excludedParticipants.length} eligible for random draw` : "eligible participants"}</small></div>
            <div className="stat-divider" />
            <div className="stat-block"><span>WINNERS DRAWN</span><strong>{data.winners.length}</strong><small>this session</small></div>
          </div>

          <div className="panel-card recent-card">
            <div className="recent-header"><div><span className="card-overline">RECENT WINNER</span><div className="recent-name">{data.winners[0]?.participant.name ?? "No winner yet"}</div></div>
              <div className="trophy-mark"><Trophy size={18} /></div></div>
            {data.winners[0] && <div className="recent-meta">
              <span><Clock3 size={13} /> {new Date(data.winners[0].timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <span className={`mode-pill mode-${data.winners[0].mode}`}>{modeLabel(data.winners[0].mode)}</span>
            </div>}
            <button className="button button-quiet history-link" disabled={drawLocked} onClick={() => setDialog("history")}><History size={15} /> View winner history</button>
            <button className="button button-danger history-clear-link" disabled={drawLocked || !data.winners.length}
              onClick={clearWinnerHistory}><Trash2 size={14} /> Clear winner history</button>
          </div>
        </aside>
      </section>

      <section className="utility-row">
        <div className="participant-summary"><div className="avatar-stack">
          {data.participants.slice(0, 4).map((person, index) => <span key={person.id} style={{ background: data.settings.colors[index % data.settings.colors.length] }}>{person.name.charAt(0).toUpperCase()}</span>)}
        </div><span><strong>{data.participants.length} names</strong> ready to play</span></div>
        <div className="utility-actions">
          <button className="button button-outline" disabled={drawLocked} onClick={() => setDialog("participants")}><ListPlus size={16} /> Participants</button>
          <label className={`button button-outline file-button${drawLocked ? " is-disabled" : ""}`}><Upload size={15} /> Import Excel
            <input type="file" accept=".xlsx,.xls,.csv" disabled={drawLocked} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadWorkbook(file);
              event.target.value = "";
            }} />
          </label>
          <button className="button button-quiet" onClick={() => void exportParticipants()} disabled={!data.participants.length}><Download size={15} /> Export</button>
        </div>
      </section>

      <footer className="page-footer"><span>YOUR EVENT. YOUR MOMENT.</span><span>{supabase ? "Shared event synced live" : "Session saved locally on this device"} <span className="saved-dot" /></span></footer>

      {winnerOverlay}
      {dialogs}
      {toastStack}
    </main>
  );
}

export default App;
