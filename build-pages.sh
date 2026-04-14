#!/bin/bash
# Build script for Cloudflare Pages — copy only deployable files
# (their build env doesn't have rsync)
mkdir -p _site

# Copy everything first
cp -r . _site/ 2>/dev/null

# Remove non-deployable dirs
rm -rf _site/_recovery \
  _site/stretch_test_tracks \
  _site/stretch_test_audio \
  _site/stretch_test_python_renders \
  _site/emic_audio \
  _site/tools \
  _site/tests \
  _site/test_interfaces \
  _site/studies-backup \
  _site/spaceweather_metadata \
  _site/cloudflare-worker \
  _site/docs \
  _site/diagnostics \
  _site/dashboards \
  _site/node_modules \
  _site/NASA \
  _site/Qualtrics \
  _site/__pycache__ \
  _site/archive \
  _site/backend \
  _site/harp \
  _site/homestretch \
  _site/wavelet_processed_audio \
  _site/wavelets \
  _site/.git \
  _site/_site

echo "Pages build: $(find _site -type f | wc -l) files"
