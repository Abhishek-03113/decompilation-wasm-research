#!/usr/bin/env python3
"""Describes a texture pack that lives in a public GitHub repository as a "remote pack": players'
browsers download its files straight from GitHub (the author's official source), pinned to one
commit, instead of from our server or bucket.

    python3 -I tools/remote_pack.py <local clone of the pack repo> <GAMEID> <out.json> [--subdir DIR]

Upload <out.json> to the Supabase bucket as remote/<name>.json; supabase/functions/games lists its
files under PSP/TEXTURES/<GAMEID>/ with raw.githubusercontent.com links (CORS-enabled, Range support).
The clone's origin must be a github.com URL; the commit is the clone's HEAD.
"""
import argparse
import json
import re
import subprocess

SKIP = {'README.md', 'README', 'LICENSE', 'LICENSE.md', '.gitattributes', '.gitignore'}


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, check=True).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('repo'); ap.add_argument('game'); ap.add_argument('out')
    ap.add_argument('--subdir', default='', help='pack folder inside the repo, if not the root')
    a = ap.parse_args()

    origin = git(a.repo, 'remote', 'get-url', 'origin').strip()
    m = re.match(r'^(?:https://github\.com/|git@github\.com:)([\w.-]+)/([\w.-]+?)(?:\.git)?/?$', origin)
    if not m:
        raise SystemExit(f'origin is not a github.com repository: {origin}')
    owner, name = m.groups()
    sha = git(a.repo, 'rev-parse', 'HEAD').strip()
    prefix = a.subdir.strip('/') + '/' if a.subdir else ''
    files = []
    for line in git(a.repo, 'ls-tree', '-r', '-l', 'HEAD').splitlines():
        meta, path = line.split('\t', 1)
        if not path.startswith(prefix):
            continue
        rel = path[len(prefix):]
        if rel in SKIP or rel.startswith('.'):
            continue
        files.append([rel, int(meta.split()[3])])
    if not any(rel == 'textures.ini' for rel, _ in files):
        raise SystemExit('no textures.ini at the pack root: pass --subdir')
    doc = {
        'name': f'{owner}/{name}', 'source': f'https://github.com/{owner}/{name}',
        'base': f'https://raw.githubusercontent.com/{owner}/{name}/{sha}/{prefix}',
        'dest': f'PSP/TEXTURES/{a.game}/', 'version': sha, 'files': files,
    }
    with open(a.out, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    print(f'{len(files)} files, {sum(s for _, s in files) / 1048576:.0f} MB, commit {sha[:7]} -> {a.out}')


if __name__ == '__main__':
    main()
