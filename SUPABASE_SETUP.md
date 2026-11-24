# Supabase setup (new project for the Lottery Ball System)

You will create a **brand-new** Supabase project. Do **not** reuse the Wheel of Fortune project, and never run `schema.sql` there.

> Supabase occasionally renames dashboard menus. If a label differs slightly, look for the closest match.

## Step 1: Sign in
Go to <https://supabase.com/dashboard> and sign in (or create an account).

## Step 2: Create the project
1. Click **New project** (choose your **Organization**).
2. **Name:** `lottery-ball-system`
3. **Database password:** click *Generate a password*, then store it in a password manager. You will not put it anywhere in this app.
4. **Region:** the one closest to where the event runs (for example *Southeast Asia (Singapore)* for the Philippines).
5. Click **Create new project** and wait until it finishes provisioning.

## Step 3: Get the credentials
Open **Project Settings, then API Keys** (or **Settings, then API**) and copy:

| Value | Looks like | Goes into |
|---|---|---|
| **Project URL** | `https://abcdefghijkl.supabase.co` | `VITE_LOTTERY_SUPABASE_URL` |
| **Publishable key** (older projects: *anon public*) | `sb_publishable_...` | `VITE_LOTTERY_SUPABASE_PUBLISHABLE_KEY` |

Never use the `service_role` / *secret* key or the database password in this app.

## Step 4: Create the database
1. **SQL Editor, then New query**.
2. Open `supabase/schema.sql` from this project, copy **all** of it, paste, and click **Run**.
3. You should see *Success. No rows returned*. If there is an error, copy the message and see `DATABASE_VERIFICATION.md`.
4. Verify using the queries in `DATABASE_VERIFICATION.md` (tables, RLS, functions, realtime).

The script is safe to run again later; it will not delete your data.

## Step 5: Authentication
1. **Authentication, then Sign In / Providers (or Providers)**: make sure **Email** is **enabled**. Keep *Confirm email* on (magic links confirm the address). The app signs operators in with an emailed link.
2. **Authentication, then URL Configuration**:
   * **Site URL:** your GitHub Pages address, e.g. `https://USERNAME.github.io/lottery-ball-system/` (use `http://localhost:5173/` until you deploy).
   * **Redirect URLs** (add each):
     * `http://localhost:5173/**`
     * `https://USERNAME.github.io/lottery-ball-system/**`
   Replace `USERNAME` (and the repository name if different). For a `USERNAME.github.io` repository the address has no sub-path.
3. **First operator account:** there is nothing to pre-create. Open `/?view=operator`, type your email and click the link in the message; the first sign-in creates the account (sign-ups are on by default). To restrict who can become an operator afterwards, turn **Allow new users to sign up** off after you have signed in once.
4. The default Supabase mail sender is rate-limited and meant for testing. For real events configure **Authentication, then SMTP Settings**.

## Step 6: Configure the app locally
```sh
cp .env.example .env.local
```
Edit `.env.local`:
```env
VITE_LOTTERY_SUPABASE_URL=https://YOUR_NEW_PROJECT_ID.supabase.co
VITE_LOTTERY_SUPABASE_PUBLISHABLE_KEY=YOUR_NEW_PUBLISHABLE_KEY
```
`.env.local` is git-ignored. **Never commit it.**

## Step 7: Install
```sh
npm ci
```

## Step 8: Run
```sh
npm run dev
```
* Operator: `http://localhost:5173/?view=operator`
* Audience: the **Audience link** button in the operator console (`http://localhost:5173/?event=<EVENT_ID>`)

## Step 9: Test the connection
1. Operator page: request the email link and sign in. You see "Your lottery events".
2. **Create event.** You land on the operator console (database connection and RLS insert work).
3. **Participants**: add a few names, or import a spreadsheet.
4. Open the audience link in a second window: the names appear (live sync).
5. Click **Draw a Winner** on the audience screen. The winner appears in the history on **both** windows (draw, finish, Realtime).
6. In Settings, set *Allow anyone with the audience link to start a draw* off: the audience button becomes disabled for visitors.

## Step 10: Test the machine
Check that the machine appears (cabinet, glass chamber, balls), the balls tumble for the whole mixing time, one ball rises into the tube, then grows into focus with a number, and finally the winner card and confetti appear.
To test the predetermined winner: pick a name under **Predetermined winner**, press **Activate one-time pick** (or your shortcut key, default **O**), draw on the audience window: the machine behaves normally and the history labels it *Operator pick*. In DevTools, Network, you will not find that name in any audience response before the reveal.

Continue with `GITHUB_DEPLOYMENT.md` to publish.
