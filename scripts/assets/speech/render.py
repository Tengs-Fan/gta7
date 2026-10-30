# Renders lines with Kokoro-82M (Apache-2.0, https://huggingface.co/hexgrad/Kokoro-82M) into 24 kHz 16-bit mono WAVs.
# Reads a JSON list of {"text", "voice", "speed", "out"} on stdin and skips entries whose "out" already exists.
# build.ts runs it with the speech virtual environment (see README.md here).
import json
import os
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

jobs = [j for j in json.load(sys.stdin) if not os.path.exists(j['out'])]
pipelines = {}
for i, job in enumerate(jobs):
    lang = job['voice'][0]
    if lang not in pipelines:
        pipelines[lang] = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M')
    chunks = [audio.numpy() for _, _, audio in pipelines[lang](job['text'], voice=job['voice'], speed=job['speed'])]
    tmp = job['out'] + '.tmp.wav'
    sf.write(tmp, np.concatenate(chunks), 24000, subtype='PCM_16')
    os.replace(tmp, job['out'])
    print(f'[{i + 1}/{len(jobs)}] {job["voice"]}: {job["text"][:60]}', flush=True)
