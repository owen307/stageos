#!/bin/bash
# StageOS ISO Builder
# Run this on Ubuntu 22.04 or 24.04 to build the bootable ISO
# Usage: sudo bash build-iso.sh

set -e
echo "Building StageOS ISO..."

apt-get update -qq
apt-get install -y debootstrap xorriso squashfs-tools grub-pc-bin grub-efi-amd64-bin mtools

mkdir -p stageos-build/{chroot,iso/{live,boot/grub,EFI/boot}}

# Bootstrap Ubuntu minimal
debootstrap --arch=amd64 --variant=minbase noble stageos-build/chroot http://archive.ubuntu.com/ubuntu

# Mount
mount --bind /dev stageos-build/chroot/dev
mount -t proc proc stageos-build/chroot/proc
mount -t sysfs sysfs stageos-build/chroot/sys

# Install packages
chroot stageos-build/chroot /bin/bash -c "
export DEBIAN_FRONTEND=noninteractive
echo 'deb http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse' > /etc/apt/sources.list
echo 'deb http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse' >> /etc/apt/sources.list
apt-get update -qq
apt-get install -y --no-install-recommends linux-image-generic live-boot systemd systemd-sysv sudo network-manager xorg openbox chromium-browser jackd2 ola nodejs npm ffmpeg thunar avahi-daemon usbutils curl wget
apt-get clean
rm -rf /var/cache/apt/archives/*.deb /usr/share/doc/* /usr/share/man/* /usr/share/locale/*
useradd -m -s /bin/bash -G audio,video,dialout,plugdev,sudo stageos
echo 'stageos:stageos' | chpasswd
echo 'stageos ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
"

# Copy StageOS apps
mkdir -p stageos-build/chroot/opt/stageos/{apps,services,assets,config}
cp -r apps/booth stageos-build/chroot/opt/stageos/apps/
cp -r apps/lightscript stageos-build/chroot/opt/stageos/apps/
cp -r apps/stageflow stageos-build/chroot/opt/stageos/apps/
cp -r apps/timecode-pro stageos-build/chroot/opt/stageos/apps/
cp os/output-daemon.js stageos-build/chroot/opt/stageos/services/
cp os/launcher.html stageos-build/chroot/opt/stageos/apps/
cp os/equipment-test.html stageos-build/chroot/opt/stageos/apps/

# Configure auto-login and boot
mkdir -p stageos-build/chroot/etc/systemd/system/getty@tty1.service.d
cat > stageos-build/chroot/etc/systemd/system/getty@tty1.service.d/override.conf << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin stageos --noclear %I $TERM
EOF
cat > stageos-build/chroot/home/stageos/.xinitrc << 'EOF'
exec openbox-session
EOF
mkdir -p stageos-build/chroot/home/stageos/.config/openbox
cat > stageos-build/chroot/home/stageos/.config/openbox/autostart << 'EOF'
node /opt/stageos/services/output-daemon.js &
sleep 2
chromium-browser --kiosk --no-sandbox --app=file:///opt/stageos/apps/launcher.html &
EOF
cat > stageos-build/chroot/home/stageos/.bash_profile << 'EOF'
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then exec startx; fi
EOF

# Unmount
umount -lf stageos-build/chroot/dev stageos-build/chroot/proc stageos-build/chroot/sys 2>/dev/null || true

# Copy kernel
cp stageos-build/chroot/boot/vmlinuz-* stageos-build/iso/live/vmlinuz
cp stageos-build/chroot/boot/initrd.img-* stageos-build/iso/live/initrd.img

# GRUB config
cat > stageos-build/iso/boot/grub/grub.cfg << 'EOF'
set default=0
set timeout=3
menuentry "StageOS" {
  linux /live/vmlinuz boot=live quiet splash
  initrd /live/initrd.img
}
EOF

# Build squashfs
mksquashfs stageos-build/chroot stageos-build/iso/live/filesystem.squashfs -comp gzip -b 1M -noappend -e boot -e proc -e sys -e dev -e run -e tmp -e var/cache/apt

# Build ISO
grub-mkrescue --output=StageOS-v1.0.iso stageos-build/iso -- -volid STAGEOS_1_0
echo "Done! StageOS-v1.0.iso is ready."
ls -lh StageOS-v1.0.iso
