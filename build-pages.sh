#!/bin/bash
# Build script for Cloudflare Pages — rsync everything EXCEPT non-deployable dirs
rsync -a \
  --exclude='_recovery' \
  --exclude='stretch_test_tracks' \
  --exclude='stretch_test_audio' \
  --exclude='stretch_test_python_renders' \
  --exclude='emic_audio' \
  --exclude='tools' \
  --exclude='tests' \
  --exclude='test_interfaces' \
  --exclude='studies-backup' \
  --exclude='spaceweather_metadata' \
  --exclude='cloudflare-worker' \
  --exclude='docs' \
  --exclude='diagnostics' \
  --exclude='dashboards' \
  --exclude='node_modules' \
  --exclude='NASA' \
  --exclude='Qualtrics' \
  --exclude='__pycache__' \
  --exclude='archive' \
  --exclude='backend' \
  --exclude='harp' \
  --exclude='homestretch' \
  --exclude='workers' \
  --exclude='wavelet_processed_audio' \
  --exclude='wavelets' \
  --exclude='_site' \
  --exclude='.git' \
  . _site/
echo "Pages build: $(find _site -type f | wc -l) files"
