# Checks that the rendered speech is intelligible: transcribes every clip in src/assets/speech with Whisper and compares
# it with what the clip should say (lines.json, written by build.ts into the speech cache). English clips are heard by
# small.en and scored by word error rate, the clips above 20 % listed; invented names (San Azura, Tiburones, ...) are
# left out of the count, since Whisper cannot know how they are spelled. Mandarin clips are heard by large-v3 and
# scored by character error rate, the clips above 5 % listed: both sides in Simplified characters (Whisper writes
# mostly Simplified), numbers in characters, 两 as 二 (Whisper writes 两点 as 2点), and only the Chinese characters
# counted, so punctuation and spacing do not.
#
#   ~/Projects/VENVS/gta7-tts/bin/python scripts/assets/speech/check.py [English model]
import json
import os
import re
import sys

import cn2an
import opencc
import whisper

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '../../../src/assets/speech')
CACHE = os.environ.get('GTA7_SPEECH_CACHE', os.path.expanduser('~/.cache/gta7-speech'))
NAMES = set('''azura san tiburones halcones moreau salgado velora nightjar thunderhoof dustrunner pipsqueak breadbox citybus
zippa marlin puffin hydra kai navarro lou dex vera benny chet bramble dolores vance fenwick morty sapd skycopter gt
hillcrest westside southgate midtown pastor pier marina tackett pruitt pettibone lindqvist pembury squawk slocum
lazer lacey simone kiki tad vic haybale rattler dooley tex lariat bootcut shoobies sharky kook tha bitcrush velour lorna
sergio bossa scotia northshore cortez
sapr reginald ashcombe pryce pru marjorie ketch marguerite vale szabo lefty truett lyle trish'''.split())

NUMBERS = {'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'}
tw2s = opencc.OpenCC('tw2s')


def words(s):
    w = re.sub(r"[^a-z0-9' ]+", ' ', s.lower().replace('-', ' ')).split()
    return [NUMBERS.get(x, x) for x in w if x.strip("'") not in NAMES]


def hanzi(s):
    return re.findall(r'[一-鿿]', cn2an.transform(tw2s.convert(s), 'an2cn').replace('两', '二'))


def errors(ref, hyp):
    """Edit distance over the reference's length: the word error rate over words, the character error rate over characters."""
    d = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(hyp) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (ref[i - 1] != hyp[j - 1]))
    return d[len(hyp)] / max(1, len(ref))


lines = json.load(open(os.path.join(CACHE, 'lines.json')))
en = whisper.load_model(sys.argv[1] if len(sys.argv) > 1 else 'small.en', device='cuda')
zh = whisper.load_model('large-v3', device='cuda') if any(l['lang'] == 'z' for l in lines.values()) else None
by_kind = {}
bad = []
for cid, line in sorted(lines.items()):
    path = os.path.join(OUT, cid + '.mp3')
    if line['lang'] == 'z':
        heard = zh.transcribe(path, language='zh', fp16=True, temperature=0, condition_on_previous_text=False)['text']
        kind, e = (cid.split('-')[0] + ' (Mandarin)', 'CER', 0.05), errors(hanzi(line['text']), hanzi(heard))
    else:
        heard = en.transcribe(path, language='en', fp16=True)['text']
        kind, e = (cid.split('-')[0], 'WER', 0.2), errors(words(line['text']), words(heard))
    by_kind.setdefault(kind, []).append(e)
    if e > kind[2]:
        bad.append((e, cid, line['text'], heard.strip()))
for e, cid, text, heard in sorted(bad, reverse=True):
    print(f'{100 * e:5.1f} % {cid}\n   said:  {text}\n   heard: {heard}')
for (kind, metric, limit), es in sorted(by_kind.items()):
    print(f'{kind}: {len(es)} clips, mean {metric} {100 * sum(es) / len(es):.1f} %, {sum(e > limit for e in es)} above {100 * limit:g} %')
