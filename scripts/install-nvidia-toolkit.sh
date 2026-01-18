#!/bin/bash
# Install NVIDIA Container Toolkit for Docker GPU support
# Usage: sudo ./install-nvidia-toolkit.sh

set -e

echo "🔧 Installing NVIDIA Container Toolkit..."

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "❌ Cannot detect OS"
    exit 1
fi

case $OS in
    ubuntu|debian)
        echo "📦 Detected Ubuntu/Debian"

        # Add NVIDIA GPG key
        curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
            gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

        # Add repository
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
            sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
            tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

        # Install
        apt-get update
        apt-get install -y nvidia-container-toolkit
        ;;

    fedora|rhel|centos)
        echo "📦 Detected Fedora/RHEL/CentOS"

        # Add repository
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
            tee /etc/yum.repos.d/nvidia-container-toolkit.repo

        # Install
        dnf install -y nvidia-container-toolkit
        ;;

    arch|manjaro)
        echo "📦 Detected Arch/Manjaro"
        pacman -S --noconfirm nvidia-container-toolkit
        ;;

    *)
        echo "❌ Unsupported OS: $OS"
        echo "Please install manually: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
        exit 1
        ;;
esac

# Configure Docker runtime
echo "🔧 Configuring Docker runtime..."
nvidia-ctk runtime configure --runtime=docker

# Restart Docker
echo "🔄 Restarting Docker..."
systemctl restart docker

# Verify installation
echo "✅ Verifying installation..."
if docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi > /dev/null 2>&1; then
    echo ""
    echo "✅ NVIDIA Container Toolkit installed successfully!"
    echo ""
    docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
else
    echo ""
    echo "⚠️  Installation completed but verification failed."
    echo "    Please check your NVIDIA driver installation."
fi
