#!/bin/bash
# Install zNode as systemd service

if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root (sudo ./install-service.sh)"
    exit 1
fi

INSTALL_DIR=$(pwd)
SERVICE_FILE="/etc/systemd/system/znode.service"

# Update service file with actual path
sed "s|WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR|g" znode.service > $SERVICE_FILE

systemctl daemon-reload
systemctl enable znode
systemctl start znode

echo "✓ zNode installed as systemd service"
echo ""
echo "Commands:"
echo "  Start:   sudo systemctl start znode"
echo "  Stop:    sudo systemctl stop znode"
echo "  Status:  sudo systemctl status znode"
echo "  Logs:    sudo journalctl -u znode -f"
