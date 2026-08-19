# 猫猫杯 淘汰赛对阵表

A static single-elimination bracket page, published with GitHub Pages, plus an editing
mode for keeping results up to date.

## Updating a result

1. In the project directory, start a local server and open the admin view:

   ```sh
   python3 -m http.server 8000
   # then open http://localhost:8000/?admin
   ```

   The server is required: the page reads `data.json` over HTTP, and writing to disk
   from the browser only works on a real origin, which a `file://` page is not.

2. First time only, click **连接项目目录** and pick this folder. The permission is
   remembered, so later sessions go straight to editing.

3. Click teams to record results, click the stones to set colours, use **编辑档案** to
   record a game's players/result/link and attach an SGF or a report PDF.

4. Click **保存到 data.json**. That writes `data.json` (and any attached files into
   `archive/`) directly. Commit and push; Pages serves the new results.

Edits are kept as a local draft in the browser as you go, so a refresh loses nothing.
Only **保存到 data.json** publishes. Without a connected directory everything still
works, but the save comes back as a download you place yourself.

## How it's put together

The guiding rule is that every fact is written down exactly once.

| File | Responsibility |
| --- | --- |
| `data.json` | All content: title, note, rosters, results, stone colours, archives. The only file that changes between matches. |
| `index.html` | A shell. No bracket markup and no results, so publishing never touches it. |
| `styles.css` | All styling. |
| `js/main.js` | Entry point; picks the mode and wires everything together. |
| `js/model.js` | The bracket as data, plus derived facts. No DOM. |
| `js/render.js` | Layout tables, and data → DOM. The only place bracket markup is produced. |
| `js/interact.js` | Click and text editing for the editable modes. |
| `js/archive.js` | The read-only per-game archive viewer. |
| `js/admin.js` | Admin mode: drafts, disk writes, the archive editor. |
| `js/watermark.js` | Side quest, see below. |
| `assets/` | Background artwork. `bg.png` is what the page draws. |
| `archive/sgf`, `archive/report` | Game records and review reports. |
| `steg/` | Offline steganography tooling for the side quest. |

Two consequences worth knowing, because they are what keep the page from drifting out
of agreement with itself:

- **Nothing is stored twice.** A semifinal team's name is not stored anywhere; it is
  computed from the rosters and the upstream winners. A match's winner is not stored
  either; it is computed from its games. So a result can never disagree with the name
  shown next to it.
- **The DOM is only ever an output.** Clicks change the data and the page re-renders
  from it. No code reads results back out of the page.

### Modes

| Mode | URL | Behaviour |
| --- | --- | --- |
| View | `/` | Read-only. Archive buttons appear only where there is something to show. |
| Edit | `/` then 编辑模式 | Anyone can try out results locally. Nothing is saved; a refresh restores the official view. |
| Admin | `/?admin` | Asks for a passphrase, then adds the archive editor, local drafts, and writing to disk. |

Admin mode is a convenience, not a security boundary — a static site cannot have one,
since all of its code is public by definition. The passphrase is checked by comparing
SHA-256 of the input against a digest stored in `js/main.js`, which keeps a passer-by
from wandering into the editor and nothing more: the check runs in the visitor's own
browser, and the digest is public and unsalted. What actually protects the published
bracket is push access to this repository. A successful unlock is remembered in
`sessionStorage` for the tab, so a refresh mid-edit does not re-prompt.

## The watermark side quest

Opening the public 编辑模式 stamps a blind DCT-domain watermark into the background
image. Because anyone may edit results locally, this is not access control; it only
marks an altered background so a casually-shared screenshot can be told apart from the
official bracket. Embedding in the frequency domain rather than in low pixel bits is
what lets the mark survive rescaling and mild recompression.

- `js/watermark.js` — the embedder that runs in the browser.
- `steg/dct_watermark.py` — the offline twin of the same algorithm.
- `steg/decode_edited_marker.py`, `steg/recover_and_decode.py` — extract the mark from a
  suspect image, the latter searching over scale and offset for a cropped screenshot.

The Python side needs `numpy` and `pillow`.

Changing the algorithm on one side requires mirroring it on the other, or the decoder
stops agreeing.
