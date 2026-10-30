# Checks that the rendered speech is intelligible: transcribes every clip in src/assets/speech with Whisper (small.en)
# and compares the words with what the clip should say (lines.json, written by build.ts into the speech cache).
# Prints the word error rate per kind of clip and the clips above 20 %. Invented names (San Azura, Tiburones, ...) are
# left out of the count: Whisper cannot know how they are spelled.
#
#   ~/Projects/VENVS/gta7-tts/bin/python scripts/assets/speech/check.py
import json
import os
import re
import sys

import whisper

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '../../../src/assets/speech')
CACHE = os.environ.get('GTA7_SPEECH_CACHE', os.path.expanduser('~/.cache/gta7-speech'))
NAMES = set('''azura san tiburones halcones moreau salgado velora nightjar thunderhoof dustrunner pipsqueak breadbox citybus
zippa marlin puffin hydra kai navarro lou dex vera benny chet bramble dolores vance fenwick morty sapd skycopter gt
hillcrest westside southgate midtown pastor pier marina'''.split())

NUMBERS = {'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'}


def words(s):
    w = re.sub(r"[^a-z0-9' ]+", ' ', s.lower().replace('-', ' ')).split()
    return [NUMBERS.get(x, x) for x in w if x.strip("'") not in NAMES]


def wer(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(hyp) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ref[i - 1] != hyp[j - 1]))
    return d[len(hyp)] / max(1, len(ref))


lines = json.load(open(os.path.join(CACHE, 'lines.json')))
model = whisper.load_model(sys.argv[1] if len(sys.argv) > 1 else 'small.en', device='cuda')
by_kind = {}
bad = []
for cid, text in sorted(lines.items()):
    heard = model.transcribe(os.path.join(OUT, cid + '.mp3'), language='en', fp16=True)['text']
    e = wer(words(text), words(heard))
    kind = cid.split('-')[0]
    by_kind.setdefault(kind, []).append(e)
    if e > 0.2:
        bad.append((e, cid, text, heard.strip()))
for e, cid, text, heard in sorted(bad, reverse=True):
    print(f'{100 * e:5.1f} % {cid}\n   said:  {text}\n   heard: {heard}')
for kind, es in sorted(by_kind.items()):
    print(f'{kind}: {len(es)} clips, mean WER {100 * sum(es) / len(es):.1f} %, {sum(e > 0.2 for e in es)} above 20 %')
