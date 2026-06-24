#!/bin/bash
# StageOS ISO Builder v1.2 - real apps, Electron runtime, working launcher
set -e

echo "=== StageOS ISO Builder v1.2 ==="

apt-get update -qq
apt-get install -y debootstrap xorriso squashfs-tools grub-pc-bin grub-efi-amd64-bin mtools live-boot

mkdir -p stageos-build/{chroot,iso/{live,boot/grub,EFI/boot}}

echo ">>> Bootstrapping Ubuntu..."
debootstrap --arch=amd64 --variant=minbase noble stageos-build/chroot http://archive.ubuntu.com/ubuntu

mount --bind /dev  stageos-build/chroot/dev
mount -t proc proc stageos-build/chroot/proc
mount -t sysfs sys  stageos-build/chroot/sys
cp /etc/resolv.conf stageos-build/chroot/etc/resolv.conf

chroot stageos-build/chroot /bin/bash -c "
export DEBIAN_FRONTEND=noninteractive
cat > /etc/apt/sources.list << 'SOURCES'
deb http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse
SOURCES
apt-get update -qq
apt-get install -y --no-install-recommends \
  linux-image-generic live-boot live-boot-initramfs-tools \
  systemd systemd-sysv sudo \
  network-manager xorg openbox \
  chromium-browser nodejs npm \
  jackd2 ola ffmpeg thunar \
  avahi-daemon usbutils curl wget \
  xterm feh unclutter \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2

# Electron needs a few extra shared libs (above) to run headless-less
# on a fresh Ubuntu minbase image — without these it fails silently.

# Install Electron globally so apps can be launched as 'electron <dir>'
echo '>>> Installing Electron runtime (this is the slow part)...'
npm install -g electron@28 --unsafe-perm 2>&1 | tail -10

# Clean up
apt-get clean
rm -rf /var/cache/apt/archives/*.deb /usr/share/doc/* /usr/share/man/*

# Create user
useradd -m -s /bin/bash -G audio,video,dialout,plugdev,sudo stageos
echo 'stageos:stageos' | chpasswd
echo 'stageos ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
echo 'stageos' > /etc/hostname

# Auto login
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/override.conf << 'GETTY'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin stageos --noclear %I \$TERM
GETTY

# Auto start X
cat > /home/stageos/.bash_profile << 'PROFILE'
if [ -z \"\$DISPLAY\" ] && [ \"\$(tty)\" = \"/dev/tty1\" ]; then
  exec startx 2>/tmp/xorg.log
fi
PROFILE

cat > /home/stageos/.xinitrc << 'XINITRC'
exec openbox-session
XINITRC

mkdir -p /home/stageos/.config/openbox
cat > /home/stageos/.config/openbox/autostart << 'AUTOSTART'
unclutter -idle 3 &
node /opt/stageos/services/output-daemon.js > /tmp/daemon.log 2>&1 &
sleep 1
chromium-browser --kiosk --no-sandbox --disable-infobars \
  --app=file:///opt/stageos/apps/launcher.html &
AUTOSTART

chown -R stageos:stageos /home/stageos
"

# ── Copy real apps into the chroot ──────────────────────────
mkdir -p stageos-build/chroot/opt/stageos/{apps,services}
for app in booth lightscript stageflow timecode-pro; do
  if [ -d "apps/\$app" ]; then
    echo ">>> Copying \$app..."
    cp -r "apps/\$app" stageos-build/chroot/opt/stageos/apps/
  fi
done
cp os/output-daemon.js     stageos-build/chroot/opt/stageos/services/
cp os/launcher.html        stageos-build/chroot/opt/stageos/apps/
cp os/equipment-test.html  stageos-build/chroot/opt/stageos/apps/

# ── Install each app's own npm dependencies inside the chroot ──
# (network still works in a chroot — it shares the host's stack)
chroot stageos-build/chroot /bin/bash -c "
cd /opt/stageos/services && npm install ws --no-save 2>&1 | tail -3
for app in booth lightscript stageflow timecode-pro; do
  if [ -f \"/opt/stageos/apps/\\\$app/package.json\" ]; then
    echo \">>> npm install for \\\$app\"
    cd \"/opt/stageos/apps/\\\$app\" && npm install --production --unsafe-perm 2>&1 | tail -5
  fi
done
"

umount -lf stageos-build/chroot/dev  2>/dev/null || true
umount -lf stageos-build/chroot/proc 2>/dev/null || true
umount -lf stageos-build/chroot/sys  2>/dev/null || true

# Copy kernel and initrd
cp stageos-build/chroot/boot/vmlinuz-*  stageos-build/iso/live/vmlinuz
cp stageos-build/chroot/boot/initrd.img-* stageos-build/iso/live/initrd.img

# GRUB config - nomodeset on by default, longer timeout, no quiet splash
cat > stageos-build/iso/boot/grub/grub.cfg << 'GRUB'
set default=0
set timeout=10

menuentry "StageOS v1.2" {
  linux /live/vmlinuz boot=live nomodeset net.ifnames=0 biosdevname=0
  initrd /live/initrd.img
}

menuentry "StageOS v1.2 (Safe Mode)" {
  linux /live/vmlinuz boot=live nomodeset xforcevesa vga=normal
  initrd /live/initrd.img
}

menuentry "StageOS v1.2 (Verbose - Show all messages)" {
  linux /live/vmlinuz boot=live nomodeset
  initrd /live/initrd.img
}
GRUB

cp stageos-build/iso/boot/grub/grub.cfg stageos-build/iso/EFI/boot/grub.cfg

# Build squashfs
echo ">>> Building filesystem..."
mksquashfs stageos-build/chroot stageos-build/iso/live/filesystem.squashfs \
  -comp gzip -b 1M -noappend \
  -e boot -e proc -e sys -e dev -e run -e tmp -e var/cache/apt

# Build ISO
echo ">>> Building ISO..."
grub-mkrescue --output=StageOS-v1.0.iso stageos-build/iso -- -volid STAGEOS_1_2

echo ">>> DONE"
ls -lh StageOS-v1.0.iso
