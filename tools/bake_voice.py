#!/usr/bin/env python3
"""Genera data/voice/es-mx.json: paquete de voz pregrabado del coach (Piper es_MX "claude").

Flujo por clip: Piper (WAV) -> recorte de silencios -> loudnorm a -14 LUFS / pico -1 dBTP -> MP3 mono 22,05 kHz 40 kbps.
El vocabulario sale de src/voicepack.js (R.voicepack.VOCAB) para tener una sola fuente de verdad.

Uso: python3 tools/bake_voice.py [--model RUTA.onnx] [--out data/voice/es-mx.json]
Requiere: python3 -m piper, ffmpeg (libmp3lame) y node.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MODEL = '/tmp/ttsdl/vits-piper-es_MX-claude-high/es_MX-claude-high.onnx'
LUFS = -14
TP = -1
MAX_BYTES = 700 * 1024


def load_vocab():
    js = ("globalThis.R={};require(%s);process.stdout.write(JSON.stringify(R.voicepack.VOCAB))"
          % json.dumps(os.path.join(ROOT, 'src', 'voicepack.js')))
    out = subprocess.run(['node', '-e', js], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def synth(model, text, wav):
    subprocess.run([sys.executable, '-m', 'piper', '-m', model, '-f', wav, '--length-scale', '0.9'],
                   input=text.encode('utf-8'), check=True, capture_output=True)


def to_mp3(wav, mp3):
    # 1) recorte de silencios al inicio y al final; 2) loudnorm (una pasada) a -14 LUFS / -1 dBTP; 3) MP3 mono 22,05 kHz 40 kbps
    trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse'
    af = '%s,loudnorm=I=%d:TP=%d:LRA=7' % (trim, LUFS, TP)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-af', af, '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '40k', mp3], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'voice', 'es-mx.json'))
    ap.add_argument('--wav-cache', help='Carpeta donde guardar/reutilizar los WAV de Piper (acelera repetir la normalización)')
    args = ap.parse_args()
    vocab = load_vocab()
    clips = {}
    with tempfile.TemporaryDirectory() as tmp:
        wavdir = args.wav_cache or tmp
        os.makedirs(wavdir, exist_ok=True)
        for e in vocab:
            wav, mp3 = os.path.join(wavdir, e['key'] + '.wav'), os.path.join(tmp, e['key'] + '.mp3')
            if not os.path.exists(wav):
                synth(args.model, e['text'], wav)
            to_mp3(wav, mp3)
            with open(mp3, 'rb') as f:
                clips[e['key']] = base64.b64encode(f.read()).decode('ascii')
    data = {'voice': 'es_MX-claude-high (Piper)', 'license': 'Apache-2.0', 'source': 'https://huggingface.co/spaces/HirCoir/Piper-TTS-Spanish', 'clips': clips}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(args.out)
    print('%d clips, %.1f KB' % (len(clips), size / 1024))
    if size > MAX_BYTES:
        print('ERROR: el paquete supera 700 KB', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
