# FEDI Boards

Pin boards where the team posts ideas and comments on them.

**Open the boards:** https://fedi-boards.as16265.workers.dev/

Sign in with your first name and the team password.

## For whoever runs the board

The board runs on Cloudflare (the NYU account, as16265@nyu.edu). There are no
access tokens to renew and nothing expires.

- **The page** is `site/`, served as static files.
- **The server** is `worker/`: one Durable Object that keeps the ideas,
  comments, boards, the list of who can sign in, the two passwords (hashed)
  and everyone's sessions in its own SQLite database. It also carries live
  updates between open boards.

### Everyday admin

Sign in under the admin's name, choose **Admin** at the bottom of the side
panel and enter the admin password. Then **People**:

- **Add or remove people.** Saving takes effect at once. Someone removed is
  signed out wherever they have the board open.
- **Change the team password.** Everyone else is signed out and signs back in
  with the new one. Do this after removing someone who knew the old password.

### What the server enforces

- Only people on the list, with the team password, can sign in. Ten wrong
  passwords from one address lock it out for 15 minutes.
- Posts are credited to the signed-in name; nobody can post as someone else.
- Anyone can move, group and link notes. Changing or removing something is
  for the person who made it, or the admin. A board's owner can delete it,
  with everything on it.
- Private boards, and everything on them, reach their owner only, not even
  the admin.

Names are still trust-based in one way: everyone shares the team password,
so anyone who knows it can sign in as any name on the list.

### Deploying

Needs Node 20 or later. The first time, `npx wrangler@4.20.0 login` connects
this computer to the Cloudflare account.

```sh
npm run check    # offline checks
npm run dev      # the page and server on http://localhost:8787
npm run deploy   # checks, then publishes to Cloudflare
```

`npm run dev` keeps its data in `.wrangler/` (ignored by git). A new board
asks for a setup code on first visit: for local runs, put
`SETUP_CODE=anything` in `.dev.vars`; on Cloudflare it's the `SETUP_CODE`
secret, and it stops working once the board is set up.

The board began on GitHub (issues in a private repository); its ideas were
copied over when it moved, which is why the server stores them in the shape
GitHub issues had.

## License

MIT
