# archive/

Match record files referenced by the per-game archive feature (see `admin.html`'s
"编辑资料" panel on each match box).

Files here are named `<matchId>.<ext>` (e.g. `qf1.pdf`, `final.sgf`), matching the
`reportPath` stored in that match's `data-archive` JSON attribute in `index.html`.

When you attach a 复盘报告 file in `admin.html` and save, the file downloads to your
browser's downloads folder with the correct name — move it into this folder manually
before syncing/pushing, or GitHub Pages won't be able to serve it.
