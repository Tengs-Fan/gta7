# Builds src/ui/fonts/noto-sans-tc-subset.woff2: Noto Sans CJK TC Bold (SIL Open Font License 1.1,
# https://github.com/notofonts/noto-cjk) cut down to the Chinese the HUD shows, every character beyond ASCII in the
# radio's tables (STATIONS in src/audio/radio.ts, HITS and CUTS in src/audio/stations/playlists.ts). The HUD draws
# 月光電台's name, tag and songs in it, so they look the same everywhere, with or without a Chinese font on the machine.
# The font keeps its name table, where its copyright and license are. Rerun after writing new Chinese there:
# tests/unit/hud_font.test.ts fails until the font has every character.
#
#   ~/Projects/VENVS/gta7-tts/bin/python scripts/assets/font.py [NotoSansCJK-Bold.ttc or NotoSansCJKtc-Bold.otf]
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTCollection, TTFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../..')
SOURCES = ['src/audio/radio.ts', 'src/audio/stations/playlists.ts']
OUT = os.path.join(ROOT, 'src/ui/fonts/noto-sans-tc-subset.woff2')

src = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc'
text = ''.join(sorted({c for f in SOURCES for c in open(os.path.join(ROOT, f), encoding='utf-8').read() if ord(c) > 0x7f}))
fonts = TTCollection(src).fonts if src.endswith('.ttc') else [TTFont(src)]
font = next(f for f in fonts if f['name'].getDebugName(1) == 'Noto Sans CJK TC')
sub = subset.Subsetter(subset.Options(name_IDs=['*']))
sub.populate(text=text)
sub.subset(font)
font.flavor = 'woff2'
os.makedirs(os.path.dirname(OUT), exist_ok=True)
font.save(OUT)
print(f'{len(text)} characters, {os.path.getsize(OUT)} bytes: {text}')
