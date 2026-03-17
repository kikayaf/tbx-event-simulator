#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Ubuntu VM Setup Script for TBX Event Simulator
# ---------------------------------------------------------------------------
# Run once on a fresh Ubuntu 22.04+ VM to install all prerequisites.
# Usage:  chmod +x setup.sh && ./setup.sh
# ---------------------------------------------------------------------------

set -euo pipefail

echo "==========================================="
echo "  TBX Event Simulator - Ubuntu VM Setup"
echo "==========================================="

# --- Node.js 20 via NodeSource -------------------------------------------
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "[1/4] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/4] Node.js $(node -v) already installed. Skipping."
fi

# --- Docker Engine -------------------------------------------------------
if ! command -v docker &>/dev/null; then
  echo "[2/4] Installing Docker..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "  -> Docker installed. You may need to log out and back in for group changes."
else
  echo "[2/4] Docker $(docker --version | awk '{print $3}') already installed. Skipping."
fi

# --- npm dependencies ----------------------------------------------------
echo "[3/4] Installing npm dependencies..."
npm install

# --- Build TypeScript ----------------------------------------------------
echo "[4/4] Building TypeScript..."
npm run build

echo ""
echo "==========================================="
echo "  Setup complete!"
echo ""
echo "  Quick start:"
echo "    docker compose up --build"
echo ""
echo "  Local dev:"
echo "    docker compose up rabbitmq"
echo "    npm run dev:all"
echo ""
API_PORT=$(grep '^API_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)
echo "  API will be at http://localhost:${API_PORT}"
echo "  RabbitMQ UI at http://localhost:15672"
echo "==========================================="
