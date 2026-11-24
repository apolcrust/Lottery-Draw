# GitHub repository and GitHub Pages deployment

Use a **new** repository. Do not push over the Wheel of Fortune repository.

## Step 11: Create and push the repository
1. On GitHub: **New repository**, name `lottery-ball-system`, leave it empty (no README/.gitignore).
2. In the project folder:
```bash
git init
git add .
git commit -m "Initial Lottery Ball System"
git branch -M main
git remote add origin https://github.com/USERNAME/lottery-ball-system.git
git push -u origin main
```
**Replace `USERNAME`** with your GitHub username. Before committing, run `git status` and confirm `.env.local` and `node_modules` are **not** listed.

The first push starts the workflow, which will fail at "Validate" until you finish Step 12. That is expected.

## Step 12: Add the secrets
GitHub repository, **Settings, then Secrets and variables, then Actions, then New repository secret**:

| Name | Value |
|---|---|
| `VITE_LOTTERY_SUPABASE_URL` | Project URL of the **new** project, `https://YOUR_NEW_PROJECT_ID.supabase.co` |
| `VITE_LOTTERY_SUPABASE_PUBLISHABLE_KEY` | The new project's publishable key |

Do not add the old `VITE_SUPABASE_*` secrets, a service-role key, or the database password.

## Step 13: Enable Pages
**Settings, then Pages, then Build and deployment, then Source: GitHub Actions.**
Then open the **Actions** tab, pick *Deploy Lottery Ball System to GitHub Pages*, and **Re-run all jobs** (or push a commit). When both jobs (`build`, `deploy`) are green, the site URL appears on the `deploy` job and under Settings, Pages.

The workflow installs dependencies, validates the two secrets, runs `npm test`, builds with the correct base path (`/lottery-ball-system/` for a project site, `/` for a `USERNAME.github.io` repository), and deploys.

## Step 14: Production redirect URLs in Supabase
**Authentication, then URL Configuration**:
* Site URL: `https://USERNAME.github.io/lottery-ball-system/`
* Redirect URLs: `https://USERNAME.github.io/lottery-ball-system/**` (keep the localhost one for development)

Operator URL: `https://USERNAME.github.io/lottery-ball-system/?view=operator`
Audience URL: shown by **Audience link** in the console: `https://USERNAME.github.io/lottery-ball-system/?event=<EVENT_ID>`

## Step 15: Final checklist
- [ ] Actions run is green; the site opens.
- [ ] `?view=operator` shows the sign-in; the email link signs you in on the deployed site.
- [ ] Event creation works; the audience link opens in a second device.
- [ ] Names added on one device appear on the other.
- [ ] The lottery machine is drawn (cabinet, glass chamber, balls).
- [ ] A draw mixes for the configured time, reveals, and shows the winner on both devices.
- [ ] Winner history, search, export and restore work.
- [ ] Predetermined winner + shortcut work and the name is not visible to the audience beforehand.
- [ ] Refresh the audience page mid-draw: it resumes and still finishes once.
- [ ] No request goes to the old Wheel of Fortune project (Network tab: only your new `*.supabase.co` host).
- [ ] Fullscreen, music toggle and mobile layout look right.
