#!/usr/bin/env python3
"""Generate the Horizon blame-pipeline architecture diagram as an SVG."""

import sys
from html import escape

W, H = 1520, 900
M = 40

BG        = "#FFFFFF"
BAND      = "#F1F4F7"
BOX       = "#FFFFFF"
STROKE    = "#B5C0CB"
INK       = "#111820"
MUTED     = "#5E6A78"
ACCENT    = "#0E6E8C"
ACCENT_BG = "#E6F1F5"
ARROW     = "#46525F"
RULE      = "#D8DEE4"

MONO = "Menlo, DejaVu Sans Mono, Consolas, monospace"
SANS = "Helvetica Neue, Helvetica, Arial, sans-serif"

out = []


def add(s):
    out.append(s)


def text(x, y, s, size=12, fill=INK, family=SANS, weight="400", anchor="start",
         spacing=None, halo=False):
    sp = f' letter-spacing="{spacing}"' if spacing else ""
    # A halo keeps a label readable where a connector runs behind it.
    h = f' stroke="{BG}" stroke-width="4.5" paint-order="stroke"' if halo else ""
    add(f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" '
        f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{sp}{h}>{escape(s)}</text>')


def box(x, y, w, h, *, fill=BOX, stroke=STROKE, width=1.4, rx=8, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="{width}"{d}/>')


def line(x1, y1, x2, y2, *, arrow=False, color=ARROW, width=1.6):
    m = ' marker-end="url(#a)"' if arrow else ""
    add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" '
        f'stroke-width="{width}" stroke-linecap="round"{m}/>')


def path(d, *, arrow=False, color=ARROW, width=1.6):
    m = ' marker-end="url(#a)"' if arrow else ""
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
        f'stroke-linecap="round" stroke-linejoin="round"{m}/>')


def layer_label(x, y, code, name, halo=False):
    text(x, y, code, size=12.5, fill=ACCENT, family=MONO, weight="600", spacing="0.6", halo=halo)
    text(x + 28, y, name, size=12.5, fill=MUTED, family=SANS, weight="500", halo=halo)


def pr_tag(cx, y, label):
    w = 50
    add(f'<rect x="{cx - w/2}" y="{y - 13}" width="{w}" height="19" rx="4" '
        f'fill="{ACCENT_BG}"/>')
    text(cx, y + 1, label, size=11, fill=ACCENT, family=MONO, weight="600", anchor="middle")


add(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
add('<defs><marker id="a" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="7.5" '
    f'markerHeight="6.5" orient="auto"><polygon points="0 0, 10 4, 0 8" fill="{ARROW}"/>'
    '</marker></defs>')

# ------------------------------------------------------------------ resources
box(M, 26, W - 2 * M, 50, fill=BAND, stroke=RULE, width=1.2, dash="6 5", rx=9)
text(M + 18, 48, "RESOURCES", size=11, fill=MUTED, family=MONO, weight="600", spacing="1.1")
text(M + 18, 66, "shared — never assets", size=11.5, fill=MUTED)
text(W - M - 18, 58, "GiteaClient  ·  AuthentikClient  ·  GitWorkspace  ·  PostgresResource",
     size=13.5, fill=INK, family=MONO, weight="500", anchor="end")

# ----------------------------------------------------------- L1 / L2 / L3 row
R1_Y, R1_H, BW = 122, 106, 300
xs = [M, M + 380, M + 760, M + 1140]

layer_label(xs[0], 108, "L1", "source")
layer_label(xs[1], 108, "L2", "capture")
layer_label(xs[2], 108, "L3", "parse")
layer_label(xs[3], 108, "L1", "source — directory")

box(xs[0], R1_Y, BW, R1_H)
text(xs[0] + 18, R1_Y + 32, "gitea_repository", size=14, family=MONO, weight="600")
text(xs[0] + 18, R1_Y + 58, "one API call", size=12.5, fill=MUTED)
text(xs[0] + 18, R1_Y + 82, "names the repo and its default branch", size=11.5, fill=MUTED)

box(xs[1], R1_Y, BW, R1_H)
text(xs[1] + 18, R1_Y + 32, "blame_capture", size=14, family=MONO, weight="600")
text(xs[1] + 18, R1_Y + 58, "clone + blame  →  raw text to disk", size=12.5, fill=MUTED)
text(xs[1] + 18, R1_Y + 82, "the only asset touching network or disk", size=11.5, fill=MUTED)

box(xs[2], R1_Y, BW, R1_H, stroke=ACCENT, width=1.9)
text(xs[2] + 18, R1_Y + 32, "blame_records", size=14, family=MONO, weight="600")
text(xs[2] + 18, R1_Y + 58, "text → records", size=12.5, fill=MUTED)
text(xs[2] + 18, R1_Y + 82, "PURE — no I/O, all 14 blame fields",
     size=11.5, fill=ACCENT, weight="600")

box(xs[3], R1_Y, BW, R1_H)
text(xs[3] + 18, R1_Y + 32, "authentik_users", size=14, family=MONO, weight="600")
text(xs[3] + 18, R1_Y + 58, "the roster — user PK, username, email", size=12.5, fill=MUTED)
text(xs[3] + 18, R1_Y + 82, "blame cannot supply a user identity", size=11.5, fill=MUTED)

line(xs[0] + BW, R1_Y + R1_H / 2, xs[1] - 10, R1_Y + R1_H / 2, arrow=True)
line(xs[1] + BW, R1_Y + R1_H / 2, xs[2] - 10, R1_Y + R1_H / 2, arrow=True)

for x, pr in zip(xs, ("PR 2", "PR 2", "PR 3", "PR 12")):
    pr_tag(x + BW / 2, R1_Y + R1_H + 26, pr)

# --------------------------------------------------------------------- L4 row
R2_Y, R2_H = 322, 98
l4a, l4b = M, M + 380

layer_label(M, 278, "L4", "load — the only layer that writes the core tables")

path(f"M {xs[2] + BW/2} {R1_Y + R1_H + 40} L {xs[2] + BW/2} {298} "
     f"L {l4a + BW/2} {298} L {l4a + BW/2} {R2_Y - 10}", arrow=True)
text(xs[2] + BW / 2 - 14, 292, "records", size=11, fill=MUTED, family=MONO, anchor="end")

box(l4a, R2_Y, BW, R2_H)
text(l4a + 18, R2_Y + 34, "blame_commits_table", size=14, family=MONO, weight="600")
text(l4a + 18, R2_Y + 60, "one row per surviving commit", size=12, fill=MUTED)
text(l4a + 18, R2_Y + 82, "per-commit fields live here, not on every line",
     size=11.5, fill=MUTED)

box(l4b, R2_Y, BW, R2_H)
text(l4b + 18, R2_Y + 34, "blame_attribution_table", size=14, family=MONO, weight="600")
text(l4b + 18, R2_Y + 60, "surviving lines per file per commit", size=12, fill=MUTED)
text(l4b + 18, R2_Y + 82, "source_path differs from path under -M / -C",
     size=11.5, fill=MUTED)

line(l4a + BW, R2_Y + R2_H / 2, l4b - 10, R2_Y + R2_H / 2, arrow=True)
pr_tag(l4b + BW + 66, R2_Y + R2_H / 2 + 4, "PR 4")

# ---------------------------------------------------------- L5 label, then bus
L5_LABEL_Y = R2_Y + R2_H + 34
BUS_Y = L5_LABEL_Y + 44

# Drawn before the labels below: these two connectors run behind the caption, and
# the caption's halo has to paint over them, not the other way round.
path(f"M {l4a + BW/2} {R2_Y + R2_H} L {l4a + BW/2} {BUS_Y}")
path(f"M {l4b + BW/2} {R2_Y + R2_H} L {l4b + BW/2} {BUS_Y}")

layer_label(M, L5_LABEL_Y, "L5",
            "features — one family per PR, narrow and independently re-materializable",
            halo=True)
text(M, L5_LABEL_Y + 19,
     "every feature reads the two core tables and never another feature, so a broken "
     "calculation blocks nothing else",
     size=11.5, fill=MUTED, halo=True)

FW, GAP = 166, 16
fx = [M + i * (FW + GAP) for i in range(8)]
line(fx[0] + FW / 2, BUS_Y, fx[7] + FW / 2, BUS_Y, width=1.9)

# The roster drops to the right of the bus's right end, so it reads as a second
# input to identity rather than another branch off the core tables.
ROSTER_X = fx[7] + FW - 30
path(f"M {ROSTER_X} {R1_Y + R1_H} L {ROSTER_X} {BUS_Y + 46 - 10}", arrow=True)
text(ROSTER_X - 8, BUS_Y - 10, "user PK", size=11, fill=MUTED, family=MONO, anchor="end")

# -------------------------------------------------------------- L5 feature row
L5_Y, L5_H = BUS_Y + 46, 124
features = [
    (["file_ownership", "member_ownership"], "PR 5",  "share per file"),
    (["member_repo_", "  ownership"],        "PR 6",  "share per repo"),
    (["repo_", "  concentration"],           "PR 7",  "bus factor, HHI"),
    (["path_classification", "member_file_mix"], "PR 8", "code vs docs vs data"),
    (["member_activity"],                    "PR 9",  "first / last, timezone"),
    (["member_durability"],                  "PR 10", "what survived"),
    (["member_process", "  _signals"],       "PR 11", "non_boundary_lines"),
    (["identity_candidates", "identity_clusters"], "PR 12–13", "git identity → user PK"),
]

for x, (names, pr, note) in zip(fx, features):
    line(x + FW / 2, BUS_Y, x + FW / 2, L5_Y - 10, arrow=True)
    box(x, L5_Y, FW, L5_H)
    ty = L5_Y + 28
    for n in names:
        text(x + 13, ty, n, size=11, family=MONO, weight="600")
        ty += 17
    text(x + 13, L5_Y + L5_H - 16, note, size=10.5, fill=MUTED)
    pr_tag(x + FW / 2, L5_Y + L5_H + 26, pr)

# ------------------------------------------------------- converge into the mart
OUT_Y = L5_Y + L5_H + 52
for x in fx:
    path(f"M {x + FW/2} {L5_Y + L5_H + 36} L {x + FW/2} {OUT_Y}")
line(fx[0] + FW / 2, OUT_Y, fx[7] + FW / 2, OUT_Y, width=1.9)

MART_Y, MART_W, MART_H = OUT_Y + 48, 300, 84
layer_label(M, OUT_Y + 28, "L6", "mart")
line(M + MART_W / 2, OUT_Y, M + MART_W / 2, MART_Y - 10, arrow=True)

box(M, MART_Y, MART_W, MART_H, stroke=ACCENT, width=1.9, fill=ACCENT_BG)
text(M + 18, MART_Y + 34, "member_profile", size=14, family=MONO, weight="600")
text(M + 18, MART_Y + 60, "keyed on authentik_user_pk", size=12, fill=MUTED)

pr_tag(M + MART_W + 56, MART_Y + 34, "PR 14")
text(M + MART_W + 100, MART_Y + 30,
     "Joins every feature table through identity_clusters, so consumers never write an eight-way join.",
     size=12.5, fill=INK)
text(M + MART_W + 100, MART_Y + 52,
     "Raw git identity stays visible beside the canonical one.", size=12.5, fill=INK)
text(M + MART_W + 100, MART_Y + 76,
     "Unmatched git identities keep a null PK so totals still reconcile.  "
     "PR 15 adds no assets: it re-keys this graph as dynamic partitions on org/repo.",
     size=11.5, fill=MUTED)

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" '
       f'height="{H}" role="img" aria-label="Horizon blame pipeline architecture in six '
       f'layers: gitea_repository feeds blame_capture, which feeds the pure parser '
       f'blame_records; records load into blame_commits_table and blame_attribution_table; '
       f'those two core tables fan out to eight independent feature families in PRs 5 '
       f'through 12, which converge into the member_profile mart in PR 13.">\n'
       + "\n".join(out) + "\n</svg>\n")

sys.stdout.write(svg)
