# Idea Board

A pin board where a team posts ideas and talks them through. People sign in
with their first name and a shared team password, pin ideas as notes, and
comment on each other's notes. Ideas are grouped into tabs down the left side,
and only the board's admin can create, rename, reorder or delete tabs.

It runs entirely on GitHub. There is no server to host or pay for.

- **The page** is a static site on GitHub Pages, built by GitHub Actions.
- **Ideas and comments** are issues and issue comments in a separate
  **private** repository. Nothing anyone posts is stored in this public repo.
- **Passwords, the access list and the API keys** live in GitHub Actions
  secrets. They never appear in this repository or in the published page.

## How sign-in works

A static page can't keep a secret, so the board doesn't try to. At deploy
time the workflow reads the secrets and seals two boxes into `vault.json`
(PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM):

| Box    | Opened with        | Holds                                                      |
| ------ | ------------------ | ---------------------------------------------------------- |
| member | the team password  | a GitHub key for the data repo, and the list of first names |
| admin  | the admin password | a second key that can also change the tab list              |

Signing in opens the member box in the browser and checks the first name
against the list inside it. Without the password the published page gives
away nothing: not the key, not the names, not the data repo's name.

The tab list is a file in the data repo. The member key can read files but not
write them, so "only the admin creates tabs" is enforced by GitHub itself, not
just by hiding a button.

## What it protects, and what it doesn't

- **Names are trust-based.** Everyone shares one password, so anyone who has
  it can sign in under any name on the list. This is a team board for people
  who trust each other, not an identity system.
- **The vault can be guessed at offline.** Anyone can download `vault.json`
  and try passwords against it. The 600,000 rounds make each guess slow, but a
  short or predictable team password is still the weakest link. Use a long one.
- **Removing a name stops new sign-ins, and that's all it does.** Someone who
  already had the password could have kept the key it unlocks. To cut a person
  off completely, change `BOARD_PASSWORD` **and** regenerate `MEMBER_TOKEN`.
- Editing and deleting are limited to the author or the admin **in the page**.
  Anyone holding the member key could close any idea directly through the API.
  Closed ideas are hidden, not destroyed, and can be reopened on GitHub.

## Setting it up

You need two repositories: this one (public, hosts the page) and a **private**
data repository. The data repo holds:

- `ACCESS.md` lists who can sign in, one first name per bullet.
- `tabs.json` is the tab list. It starts with one tab.
- `.github/workflows/sync-access.yml` copies `ACCESS.md` into this repo's
  `ALLOWED_NAMES` secret and redeploys the board whenever the file changes.

### 1. Create three fine-grained tokens

Go to GitHub → Settings → Developer settings → Fine-grained tokens. For each
token, set an expiry you'll remember: the board stops working when its key
expires.

| Token          | Repository access    | Permissions                                       |
| -------------- | -------------------- | ------------------------------------------------- |
| `MEMBER_TOKEN` | the data repo only   | Issues: read and write · Contents: read-only      |
| `ADMIN_TOKEN`  | the data repo only   | Issues: read and write · Contents: read and write |
| `SYNC_TOKEN`   | this board repo only | Secrets: read and write · Actions: read and write |

### 2. Add the secrets

In **this** repository: Settings → Secrets and variables → Actions.

| Secret           | What it is                                                   |
| ---------------- | ------------------------------------------------------------ |
| `BOARD_PASSWORD` | the team password everyone signs in with                     |
| `ADMIN_PASSWORD` | the admin's own password, which turns on the tab tools       |
| `ADMIN_NAME`     | the admin's first name, as it appears in the access list     |
| `ALLOWED_NAMES`  | first names, one per line; kept in sync from `ACCESS.md`     |
| `DATA_REPO`      | the data repository, as `owner/name`                         |
| `MEMBER_TOKEN`   | token from step 1                                            |
| `ADMIN_TOKEN`    | token from step 1                                            |

In the **data** repository, add `SYNC_TOKEN`.

### 3. Turn on Pages and deploy

Settings → Pages → Source: **GitHub Actions**. Then Actions → Deploy board →
Run workflow. If any secret is missing, the board still deploys and says it
isn't set up yet. The run's summary lists which secrets are missing.

## Managing the board

- **Add or remove people:** edit `ACCESS.md` in the data repo on GitHub and
  commit. The board redeploys in about a minute, and everyone signs in again.
- **Admin tools:** sign in under the admin's name, then choose **Admin** at the
  bottom of the sidebar and enter the admin password.
- **Change a password:** update the secret, then run Deploy board.
- **Notifications:** the token owner's account is credited with every post. To
  avoid an email per idea, set the data repo to *Ignore* (Watch → Ignore).

## Developing locally

Needs Node 20 or later and nothing else: no dependencies, no bundler.

```sh
npm run check                       # offline checks
BOARD_PASSWORD=... ADMIN_PASSWORD=... ADMIN_NAME=... ALLOWED_NAMES=... \
MEMBER_TOKEN=... ADMIN_TOKEN=... DATA_REPO=owner/name npm run build
npx serve dist                      # or: python -m http.server -d dist
```

`dist/` is ignored by git. Don't commit it: its `vault.json` holds sealed keys.

## License

MIT
