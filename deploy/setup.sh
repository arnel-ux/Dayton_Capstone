#!/usr/bin/env bash
# One-time provisioning script for a fresh Azure/Oracle/any Ubuntu VM to run
# the CQA admin portal: Node/Express + a persistent Python transformer model
# server, connecting to an external MySQL (Clever Cloud) via env vars, behind
# Nginx.
#
# Usage (as the azureuser/ubuntu user, with sudo):
#   git clone <your-repo-url> ~/Dayton_Capstone
#   cd ~/Dayton_Capstone
#   chmod +x deploy/setup.sh
#   ./deploy/setup.sh
#
# Safe to re-run — apt/pip/npm installs are idempotent.

set -euo pipefail

APP_DIR="$HOME/Dayton_Capstone/admin-portal"
VENV_DIR="$APP_DIR/venv"
SERVICE_NAME="cqa-admin-portal"

echo "==> Updating system packages"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "==> Installing Node.js 20 LTS"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "==> Installing Python, build tools, Nginx, git"
sudo apt-get install -y python3 python3-venv python3-pip build-essential nginx git

echo "==> Creating Python virtual environment (venv/bin/python is what Node's"
echo "    child_process.spawn('python', ...) will resolve via PATH)"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$APP_DIR/ai_scripts/requirements.txt"

echo "==> Installing Node dependencies"
cd "$APP_DIR"
npm install --omit=dev

if [ ! -f "$APP_DIR/.env" ]; then
    echo "==> No .env found — copying deploy/.env.example. EDIT IT before starting the service."
    cp "$HOME/Dayton_Capstone/deploy/.env.example" "$APP_DIR/.env"
fi

echo "==> Installing systemd service"
sudo cp "$HOME/Dayton_Capstone/deploy/cqa-admin-portal.service" /etc/systemd/system/
sudo sed -i "s#__APP_DIR__#$APP_DIR#g; s#__VENV_DIR__#$VENV_DIR#g; s#__USER__#$(whoami)#g" \
    /etc/systemd/system/cqa-admin-portal.service
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo "==> Installing Nginx reverse proxy (port 80 -> 127.0.0.1:3000)"
sudo cp "$HOME/Dayton_Capstone/deploy/nginx-cqa.conf" /etc/nginx/sites-available/cqa
sudo ln -sf /etc/nginx/sites-available/cqa /etc/nginx/sites-enabled/cqa
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

echo "==> Opening OS firewall (ufw) for HTTP/HTTPS/SSH"
if command -v ufw >/dev/null; then
    sudo ufw allow OpenSSH
    sudo ufw allow 'Nginx Full'
    sudo ufw --force enable
fi

echo ""
echo "=================================================================="
echo "Done. Remaining manual steps:"
echo "  1. Edit $APP_DIR/.env with real secrets (Google OAuth, mail, and the"
echo "     Clever Cloud DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME values)."
echo "  2. In the Azure Portal, confirm the Networking tab allowed inbound"
echo "     ports 80 and 443 (should already be set from VM creation)."
echo "  3. Start the app:  sudo systemctl start $SERVICE_NAME"
echo "  4. Check logs:     sudo journalctl -u $SERVICE_NAME -f"
echo "  5. Visit http://<your-vm-public-ip>/ in a browser."
echo "=================================================================="
