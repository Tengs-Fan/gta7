# Speech

`npm run speech` renders everything the game says out loud into `src/assets/speech/`: one 32 kbps mono MP3 per clip and `speech.json`, the index the sim and the audio read (`src/sim/speech.ts`).
The voices are [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) v1.0 (Apache-2.0, model and voices), run offline; the lines are original.

| File | Role |
| --- | --- |
| `script.ts` | The cast (a Kokoro voice or blend per role), AZURA TALK's programme (Chet Bramble's monologues, callers, the newsdesk, traffic and idents), the ads of every talk station and the shouts of people, officers and gangs. |
| `shows/` | The other talk shows, one file each (`bowl.ts`: THE BOWL 1090 AM), collected in `shows/index.ts`: their pieces, their own ads and their idents. |
| `djs.ts` | The music stations' DJs: a voice each (a blend where a voice alone is already somebody else), their idents, banter, lines for the night, the rain, a chase and a getaway, and the frames they announce and back-announce the hits of `src/audio/stations/playlists.ts` with. |
| `dialogue.ts` | Reads the mission dialogue from `src/sim/missions/*.ts`: every `m.say(SPEAKER, …)` and `[SPEAKER, …]` intro line, both branches of a ternary, template literals evaluated against the generated city. Adds the phone's offer and busy lines. |
| `phrases.ts` | The police dispatcher's phrases, from `src/sim/dispatch.ts`'s tables, the vehicle names and the city's zone names. The scanner joins them, longest match first. |
| `news.ts` | Every sentence the Azura Newsdesk can read, from the tables in `src/audio/newsText.ts`: those that name a place once per zone, the chase leads once per part of the day and for last night and yesterday, the weather's arrivals once per part of the day. A bulletin joins them at sentence boundaries. |
| `missionNews.ts` | The newsdesk's piece on each mission of the story when it is passed, and the follow-up a game day later; neither says what day it happened, since either may air a day late. |
| `build.ts` | Renders new lines (`render.py`), trims, band-limits the callers and the Skycopter to a phone line, levels every clip to the same loudness, encodes with ffmpeg, writes the index (each show's pools and the ad campaigns) and removes clips nobody uses. |
| `render.py` | Kokoro, one WAV per line, cached by voice, speed and text in `~/.cache/gta7-speech` (`GTA7_SPEECH_CACHE` overrides), so a rerun renders only what changed. |
| `check.py` | Transcribes every clip with Whisper and reports the word error rate per kind of clip and the clips above 20 %. |

## Setup

Python 3.12 (Kokoro does not support newer ones yet), espeak-ng and ffmpeg (with libmp3lame) on the path:

```sh
uv venv --python 3.12 ~/Projects/VENVS/gta7-tts
VIRTUAL_ENV=~/Projects/VENVS/gta7-tts uv pip install kokoro soundfile openai-whisper \
  "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
npm run speech                                                   # GTA7_TTS_PYTHON overrides the interpreter
~/Projects/VENVS/gta7-tts/bin/python scripts/assets/speech/check.py   # optional: intelligibility
```

The model downloads from Hugging Face on first use. A CUDA GPU renders the whole set in a few minutes; a CPU works too, more slowly.

## Talk pieces

A piece is one clip: its lines in order, with a short pause between them.
`show` names the talk show it belongs to (AZURA TALK's by default); an ad lists in `shows` every show whose breaks may play it.
An ad campaign is a `series` of pieces with a `part` each, from 1: the ad pools hold its first part, and each time a programme draws it, the next part airs.
A line may carry options as its third element: `{ speed: 1.5 }` for fine print read fast (an ad's lines are otherwise read at 1.05), `{ phone: true }` for a role down a phone line just this once, `{ phone: false }` for a caller who is in the room.
A cast entry such as `'am_onyx,am_fenrir'` is a blend: Kokoro averages the voices, and the first one sets the language.

## When to rerun

After changing a line of mission dialogue, a contact's name, a mission title, a vehicle name, a zone, a dispatch line or anything in `script.ts`, `shows/`, `missionNews.ts` or `src/audio/newsText.ts`.
`tests/unit/speech.test.ts` fails until every line the game can say has its clip, and the index lists exactly the files on disk; `tests/unit/news.test.ts` does the same for every sentence a bulletin can be read with.
A new mission speaker needs a role in `SPEAKERS` (`script.ts`); a mission template literal that uses something besides `sim`, `spots` and the file's exports needs it added to `SCOPES` (`dialogue.ts`).

## Output

- `dlg-<role>-<hash>`: a line of dialogue; `dsp-<words>`: a dispatch phrase; `talk-<piece>`: a talk station piece (THE BOWL's are `talk-bowl-…`); `bark-<kind>-<voice>-<n>`: a shout.
- `ident-<station>-<n>`: a music station's ident; `dj-<station>-<kind>-<n>`: a DJ's link (of the kinds `front` and `back`, the announce and the back-announce of hit `n`).
- `news-<hash>`: a newsdesk sentence (`speech.json` keys `news` by its text); `news-m-<mission>` and `news-m-<mission>-later`: a mission's piece and its follow-up.
- Every clip is levelled to -20 dBFS RMS over its voiced samples, peaks under -1 dBFS.
- The same input on the same machine gives the same bytes (ffmpeg runs with bitexact flags); Kokoro on another GPU or on a CPU may differ in the last bits.
