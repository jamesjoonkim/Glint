# PyInstaller spec for glint-mlx-server.
#
# Produces a single self-contained binary that wraps mlx_lm.server. Built once
# per release and shipped under resources/runtime/glint-mlx-server.
#
# Usage:
#   pyinstaller build/python/runtime.spec
# Output:
#   dist/glint-mlx-server (single binary, ~200MB after --strip)

# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

hidden = (
    collect_submodules('mlx')
    + collect_submodules('mlx_lm')
    + collect_submodules('mlx_vlm')
    + collect_submodules('huggingface_hub')
    + ['sentencepiece']
)

datas = (
    collect_data_files('mlx')
    + collect_data_files('mlx_lm')
    + collect_data_files('mlx_vlm')
)

a = Analysis(
    ['runtime_entry.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=['matplotlib', 'pandas', 'IPython', 'notebook', 'tkinter'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='glint-mlx-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    target_arch='arm64',
    codesign_identity=None,  # signed in build-runtime.sh post-step
    entitlements_file=None,
)
