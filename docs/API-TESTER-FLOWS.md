# API Tester — Flows guide

How to read, run, create and edit flows in the API Tester, for QA. No scripting needed.

Open the tester at **pandabugsreporting.com → 🧪 API Tester** (or `/apitestingbruno`) and sign in with your
dashboard account. This page is also inside the tester: **📖 Guide** at the top.

---

## 1. Introduction

The API Tester keeps all the Games Panda APIs in one shared **collection** (left side, **APIs** tab): login,
balances, challenges, match servers, games, withdraw and so on. Anyone in the team can send any of them.

A **flow** (left side, **🧪 Flows** tab) is a list of those API calls that run **one after another**, the way
the app uses them. For example:

1. Player 1 logs in
2. Player 2 logs in
3. Player 1 creates a challenge
4. Player 2 joins it
5. The match server starts
6. The game server saves the result
7. The coins moved the right way

Each step has **conditions** ("it passes when…"). A flow runs top to bottom and **stops at the first step that
does not pass**, and tells you why in plain words.

A step can **save a value** from its answer (a token, a challenge id) and later steps **use** it. That is how
step 4 joins exactly the challenge step 3 created.

> ⚠️ Flows send real requests. Steps that bet, settle or withdraw move **real coins**. Use **test accounts**,
> ideally on the staging server.

---

## 2. What flows are for

| Use | Example |
|---|---|
| Check a game's money rules | "Snooker multiplayer — P1 wins twice": the winner gets 2 × stake, the loser loses the stake |
| Check after a backend update | Run all flows; the red ones show exactly which call changed |
| Reproduce a bug | Build the exact calls that broke, share the link with the backend team |
| Check a new feature | Match server: deploy → wait until ready → result → server stopped |
| Check refusals | Deploy without a login gives 401, an unknown challenge is refused |
| Share a result | ⋯ → **🔗 Share last result** gives a link anyone can open, no sign-in needed |

---

## 3. Before you start

1. **Collection** — top left, pick *Games Panda — All Games API*.
2. **Variables** — top bar, **Variables**. The flows read these values:

   | Variable | What it is |
   |---|---|
   | `agp_url` | The server, e.g. `https://api-player.gpstagings.com` (staging) |
   | `p1_phone`, `p1_password` | Test account for **Player 1** |
   | `p2_phone`, `p2_password` | Test account for **Player 2** |
   | `flow_stake` | Coins per challenge (e.g. `100`) |
   | `flow_mp_coins`, `flow_ai_coins` | `gold` or `silver` |
   | `apk_signature`, `gameplaytoken` | Only for game-server steps |

3. **Environment** (top bar dropdown) — optional. A value in the environment wins over the same value in the
   collection. If a login suddenly fails, check that the environment does not override `p1_phone` with an old
   number.

---

## 4. Reading a flow

Click a flow in the **🧪 Flows** list. The page shows:

- **Status** — *Not run yet*, *Passed*, *Failed*, *Partly run* — and, when it failed, **"✕ Failed at step N"** with the
  reason.
- **▶ Run flow**, **✎ Edit** and **⋯** (more).
- **Before you run** — every value the flow needs from Variables. A red **not set** means fill it in first.
  **✓ Check accounts** sends only the safe first steps (logins, balance reads) so a wrong password shows up before
  any coin moves.
- **The steps**, numbered. Each step says, in words:

| Line | Meaning |
|---|---|
| **Player 1 / Player 2 / Game server / No login** | Whose token the call sends |
| `POST /session/join` | The call itself |
| ✓ **Passes when …** | The step's conditions |
| ⤓ **Saves {{flow_tx}} → used by steps 6, 7, 8** | A value this step keeps, and which later steps use it |
| ↳ **Uses {{flow_tx}} from step 5** | Where this step's values come from |
| ↻ **Tries again every 5 s, up to 36 times** | It waits for something (e.g. a match server getting ready) |
| ⑂ **Shortcut: if … → end the flow** | It can end early or jump |
| ⏱ **Waits 10 seconds** | A pause step |

After a run, each step shows **✓ Passed** or **✕ Failed — reason**, and **Response** shows exactly what came back.
**now: …** next to a saved value shows the real value from the last run (tokens are hidden).

---

## 5. Running

- **▶ Run flow** — runs every step. Untick *Mark results ✓ / ✕ automatically* if you are only trying something
  and don't want to change the team's marks.
- **▶ Run to here** (on a step) — runs steps 1 to that step only. Good for "does the challenge get created?"
  without settling it.
- **▶ Run all** (left, above the list) — runs every flow in the list, one after another, and gives one table.
  Use the search box and the *Failing / Passed / Not run* chips to run only some.
- **🔗 Share report** (after a run) — a link to a page with every step's result, for the backend team.

When a step fails, read its reason first, then **Response**. The common ones are in
[section 12](#12-when-something-fails).

---

## 6. Create a new flow

1. **🧪 Flows** tab → **+ New flow**.
2. **Flow name** — say what it proves, e.g. *Ludo multiplayer — Player 1 wins*.
   **What it proves** — one line (optional).
3. Choose how to start:
   - **+ Add the first step** — start empty, or
   - **Copy steps from an existing flow…** — start from a flow that is close (then change the game id, the names,
     and so on), or
   - an example (**✨ Password reset**).
4. Add steps (next section), one per API call, in the order the app makes them.
5. **Save flow**, or **Save & run**.

A new flow is saved into the **🧪 Flows** folder. Steps are **copies** of the APIs: changing a step never changes the
API in the APIs list, and the other way round.

---

## 7. Add an API to a flow

In the editor:

- **+ Add an API call** (at the bottom) adds a step at the end.
- **+** on a step adds a step right **after** it.

A search box opens. Type part of the name or the URL — `login`, `balance`, `session/join`, `match-server` —
and click the API. It is added and opened so you can answer its questions.

Other step types:

- **⏱ + Wait** — a pause (seconds). Use it when the server pays a little later.
- **⚡ + Socket message** — connects to a socket with a player's token, can send one event, and waits for an
  answer event (see [section 10](#10-socket-steps)).

### The API is not in the list yet

Add it to the collection first, then it shows in the search:

1. **APIs** tab → **+ Request** (or right-click a folder → *New request here*).
2. Set the **method** (GET, POST, PATCH…) and the **URL**, starting with `{{agp_url}}`, e.g.
   `{{agp_url}}/match-server/deploy`.
3. **Headers / Auth**: for a player call use Auth → Bearer → `{{p1_token}}` (the flow editor can change the player
   later). **Body**: raw JSON, e.g. `{"transaction_id": "{{flow_tx}}"}`.
4. **Send** once to check it works, then **Save** (Ctrl/Cmd + S).

---

## 8. Edit a step — the six questions

Open a flow → **✎ Edit** → **✎ Edit** on a step. Each step asks:

**1 · What is sent**
- **Who sends it** — *Player 1*, *Player 2*, *Game server*, or *As set in the API*. This picks the login token.
  If a step says **No login** and the backend answers 401, choose the player here.
- **Call** — method and URL. **Body** — the JSON that is sent (change a game id, a stake, …).
- **+ Insert a saved value…** — see [section 9](#9-save-a-value-and-use-it-in-later-steps).

**2 · It passes when** — the conditions. Every line must be true. With no conditions a step passes when the
response looks OK (HTTP 2xx and no `"status": false`). If the step came from an older flow, its own built-in checks
are listed too ("Already checked by this step's script").

| Pick | Then | Example |
|---|---|---|
| The response looks OK | — | HTTP 2xx and no `"status": false` |
| The HTTP status | is equal to | `401` for "must be refused" |
| A value in the response… | is equal to / is not / contains | `message` contains `not open` |
| | has a value / is empty | `access_token` has a value |
| | is true / is false | `status` is false |
| | is more than / is less than | `gold_balance` is more than `0` |
| | went down by / went up by … since | `silver_balance` went down by `100` since `{{silver_before}}` |
| The response time (ms) | is less than | `2000` |

A value in the response is written as a path: `status`, `data.status`, `user._id`, `data.items.0.name`.
Easiest: **▶ Try this step now** and click **✓** next to the value (see below).

**3 · Save from the answer, use in later steps** — see [section 9](#9-save-a-value-and-use-it-in-later-steps).

**4 · Ask the tester while it runs** — for what only a person has (the OTP from an SMS, a new password). The run
pauses and asks. Name the value (e.g. `otp`) and write the question.

**5 · If it does not pass**
- **Stop the flow and show what went wrong** (default), or
- **Try again every N seconds, up to M times** — for things that take time: a match server becoming ready
  (every 5 s, 36 times = 3 minutes), a payout arriving.

**6 · Shortcut (optional)** — "When *condition* then *end the flow here* / *skip the next step* / *go to step …*".
Example: when `gold_balance` is less than `100`, end the flow (no point betting).

**▶ Try this step now** sends just this one step and shows the answer. Every value in it has two buttons:
- **✓** — make it a condition ("pass only when `data.status` is `ready`"),
- **⤓** — save it for later steps.

Other buttons on a step: **↑ ↓** move it, **⧉** duplicate it, **✕** remove it. **Save flow** when done; **Cancel**
throws the changes away.

---

## 9. Save a value and use it in later steps

This is how steps talk to each other. Example: Player 1 creates a challenge, Player 2 joins **that** challenge.

**Step A — save it**

1. Edit the step that creates the challenge → **▶ Try this step now**.
2. In the answer, find `data.transaction_id` and press **⤓**. It is saved as `{{transaction_id}}` (rename it in
   section 3 if you like, e.g. `flow_tx`).
   Or type it yourself in section 3: `data.transaction_id` **as** `flow_tx`.

The step now says **Saves {{flow_tx}} → no later step uses it yet**.

**Step B — use it.** In a later step, either:

- **+ Insert a saved value…** — click in the URL or the body where the id must go, then pick `{{flow_tx}}`. It is put
  at the cursor, e.g. `{"transaction_id": "{{flow_tx}}"}` or `{{agp_url}}/match-server/{{flow_tx}}`; or
- **↺ use a saved value instead…** — next to a value under the step (*Uses …*). If the step still uses an old fixed
  value (`{{agp_session_id}} — Variables`) or one with **no value!**, pick `{{flow_tx}} from step 3` and the step is
  rewritten to use it everywhere.

Now step A says **Saves {{flow_tx}} → used by step 4**, and step B says **Uses {{flow_tx}} from step 3**.

Good to know:

- When the flow runs, `{{flow_tx}}` is replaced by the real id. After a run, **now: 3b85…** shows it.
- A saved value works for every later step until another step saves the same name again (match 2 of a flow saves
  a new `{{flow_tx}}`).
- **Login steps already save the tokens**: *Login player 1* saves `{{p1_token}}` and `{{p1_id}}`, *Login player 2*
  saves `{{p2_token}}` and `{{p2_id}}`. "Who sends it: Player 1" uses `{{p1_token}}`.
- Many APIs in the list already save what the next API needs (*Create challenge* saves `{{agp_session_id}}`,
  *Join* uses it). The editor shows those links as **← step N**.
- Values saved by a run stay **on your page only**, so two testers running at once don't overwrite each other.
- Red **{{name}} — no value!** under a step means nothing gives it a value: save it in an earlier step, ask for it
  (section 4 of the step), or fill it in **Variables**. Grey **optional, empty** is fine (an extra header the call
  works without).

---

## 10. Socket steps

For APIs that answer on a socket (match server events, socket joining):

| Field | Example |
|---|---|
| Socket URL | `{{socket_url}}/emit` |
| Connect as | Player 1 (sends `{{p1_token}}` as the login token) |
| Query | `type=mobile-client` |
| Send event | the event name to send (leave empty to only listen) |
| With data | `{"transaction_id": "{{flow_tx}}"}` |
| Wait for event | the event to wait for (empty = the first one that arrives) |
| Give up after | `30` seconds |

The answer is checked like a response: `{"event": "…", "payload": {…}}`. So a condition is written like
`payload.status` is equal to `ready`, and you can save `payload.address`.

A socket step connects, waits for one answer and disconnects. It cannot keep listening while other steps run.

---

## 11. Examples

### Login and balance (safe, no coins move)

| # | Step | Who | Passes when | Saves |
|---|---|---|---|---|
| 1 | Login with phone + password | No login | `access_token` has a value | `access_token` as `p1_token` |
| 2 | Get my gold & silver balance | Player 1 | the response looks OK | `silver_balance` as `silver_before` |

### Multiplayer challenge with the match server

| # | Step | Who | Passes when | Saves / uses |
|---|---|---|---|---|
| 1–2 | Login player 1 / 2 | No login | logged in | `p1_token`, `p2_token`, ids |
| 3 | Create challenge | Player 1 | session created | saves `flow_tx` |
| 4 | Join | Player 2 | joined | uses `flow_tx` |
| 5 | Accept (notify to play) | Player 1 | accepted | uses `flow_tx` |
| 6–7 | `POST /match-server/deploy` | Player 1, then Player 2 | `data.status` is `deploying` or `ready` | uses `flow_tx` |
| 8 | `GET /match-server/{{flow_tx}}` | Player 1 | `data.status` is equal to `ready` — **try again every 5 s, 36 times** | saves `data.address` |
| 9 | Settle (game server) | Game server | accepted | uses `flow_tx`, `p1_id` |
| 10 | `GET /match-server/{{flow_tx}}` | Player 1 | `data.status` is not `ready` | — |
| 11 | Balance after | Player 1 | `gold_balance` went up by … since `{{gold_before}}` | — |

The ready-made flows *"… multiplayer — P1 wins twice"* already have these steps.

---

## 12. When something fails

| You see | Usually means | Do |
|---|---|---|
| `invalid phone or password` at a login | Wrong test account for this server | Fix `p1_phone` / `p1_password` in **Variables** (check the environment doesn't override them) |
| `401 Unauthorized` | No token, or an old one | Run the login steps first; set **Who sends it**; a step says **No login** but needs a player |
| `404 Cannot GET /…` | The backend changed the method (GET → PATCH/POST) | Edit the step → **Call** → pick the right method |
| `403 game results are accepted from the game server only` | Only the game server may send results | The step must send as **Game server** (build token) |
| `{{x}} — no value!` / *skipped* | A value nobody set | Save it in an earlier step or fill it in Variables |
| `Still not passing after N tries` | A wait ran out (match server never got ready) | Look at **Response** of the last try — the reason is usually in `message` |
| `pm.expect(...).to.match is not a function` | A hand-written check the tester doesn't support | Remove the check and add the same condition in section 2 instead |

---

## 13. Advanced

- **⋯ → Advanced view (graph)** — the same flow as boxes and wires, for complicated flows.
- **⋯ → Edit in the classic builder** — the older drag-and-drop editor.
- **⋯ → Duplicate for another game…** — copies a flow with every game id replaced.
- **⋯ → ⚡ Load test this flow** — sends the flow many times at once (only on staging, and tell the backend team).
- Checks written as scripts in older flows still work and are shown in words; new checks should be added with the
  editor so everyone can read them.
