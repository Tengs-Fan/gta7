# Renders lines with Kokoro-82M (Apache-2.0) into 24 kHz 16-bit mono WAVs: English with v1.0
# (https://huggingface.co/hexgrad/Kokoro-82M), Mandarin with the z[fm]_NNN voices of v1.1-zh
# (https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh), one model per repository.
# Reads a JSON list of {"text", "voice", "speed", "out"} on stdin and skips entries whose "out" already exists.
# build.ts runs it with the speech virtual environment (see README.md here).
import json
import os
import re
import sys

import numpy as np
import opencc
import soundfile as sf
import torch
from kokoro import KModel, KPipeline

ZH = re.compile(r'z[fm]_\d{3}')
# A Mandarin line is written in Traditional characters and read through Simplified ones: misaki's phrase tables (tone
# sandhi, polyphones) are keyed by Simplified words, and tw2s turns the particle 著 into 着 (plain t2s keeps 著, read zhù).
tw2s = opencc.OpenCC('tw2s')
device = 'cuda' if torch.cuda.is_available() else 'cpu'

jobs = [j for j in json.load(sys.stdin) if not os.path.exists(j['out'])]
models = {}
pipelines = {}
for i, job in enumerate(jobs):
    lang = job['voice'][0]
    repo = 'hexgrad/Kokoro-82M-v1.1-zh' if ZH.match(job['voice']) else 'hexgrad/Kokoro-82M'
    if repo not in models:
        models[repo] = KModel(repo_id=repo).to(device).eval()
    if (lang, repo) not in pipelines:
        pipelines[lang, repo] = KPipeline(lang_code=lang, repo_id=repo, model=models[repo])
    text = tw2s.convert(job['text']) if lang == 'z' else job['text']
    chunks = [audio.numpy() for _, _, audio in pipelines[lang, repo](text, voice=job['voice'], speed=job['speed'])]
    tmp = job['out'] + '.tmp.wav'
    sf.write(tmp, np.concatenate(chunks), 24000, subtype='PCM_16')
    os.replace(tmp, job['out'])
    print(f'[{i + 1}/{len(jobs)}] {job["voice"]}: {job["text"][:60]}', flush=True)
