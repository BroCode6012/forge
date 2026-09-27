#!/bin/bash
# ============================================================
# Cloud Setup Script for Lightning AI (Ubuntu/Linux)
# Run once after cloning the repo:  bash setup_cloud.sh
# ============================================================

set -e

echo "=== Forge — Cloud Setup ==="

# 1. System packages
echo "📦 Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    xvfb \
    libgbm1 \
    libasound2 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libxss1 \
    libgconf-2-4 \
    libdrm2 \
    libxkbcommon0 \
    ffmpeg

echo "✅ System packages installed"

# 2. yt-dlp (Linux binary)
echo "📥 Installing yt-dlp..."
mkdir -p yt-dlp
if [ ! -f yt-dlp/yt-dlp ]; then
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp/yt-dlp
    chmod +x yt-dlp/yt-dlp
    echo "✅ yt-dlp installed"
else
    echo "✅ yt-dlp already exists"
fi

# 3. Node dependencies
echo "📦 Installing node dependencies..."
npm install

# 4. Create required directories
echo "📁 Creating directories..."
mkdir -p input temp public assets/backgrounds assets/overlays assets/sfx

# 5. Verify
echo ""
echo "=== Verification ==="
echo -n "FFmpeg: " && ffmpeg -version 2>&1 | head -1
echo -n "yt-dlp: " && ./yt-dlp/yt-dlp --version 2>/dev/null || echo "not found"
echo -n "Node:   " && node --version
echo -n "npm:    " && npm --version
echo ""
echo "🚀 Setup complete! Configure your .env file and run:"
echo "   npm run build    # Run AI build pipeline"
echo "   npm start        # Launch Electron app (needs display)"
echo ""
echo "For headless (no display) build pipeline:"
echo "   xvfb-run npm run build"
