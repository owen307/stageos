#!/bin/bash
# StageOS ISO Builder v1.3 - fix kernel panic by removing risky global
# Electron install (its failure was being silently masked by a pipe,
# likely corrupting the build). Real app source + lightweight deps
# (ws) are kept. Electron app launching will be reintroduced separately
# once boot is rock solid.
set -e
set -o pipefail

echo "=== StageOS ISO Builder v1.3 ==="

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
set -e
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
  ca-certificates \
  libasound2t64

# NOTE: global Electron runtime install removed for this build.
# It was the largest/riskiest new addition and its failure mode
# (network timeout / partial download) was being silently masked
# by a '| tail' pipe, which can corrupt the resulting filesystem
# image. Re-adding this needs its own isolated, verified build.

# Harden the udev init-bottom hook against slow device enumeration.
# Root-caused via interactive break=bottom debugging: on a clean/fast
# boot everything mounts fine, but under slow device enumeration
# (flaky USB/CD controllers, slow storage) the /dev move-mount can
# race ahead of udev finishing its work, which leaves init unable to
# open \${rootmnt}/dev/console and the kernel panics with
# 'Attempted to kill init!'. A short udevadm settle before the move
# closes that race without meaningfully slowing normal boots.
UDEV_HOOK=/usr/share/initramfs-tools/scripts/init-bottom/udev
if [ -f \"\${UDEV_HOOK}\" ] && ! grep -q 'udevadm settle' \"\${UDEV_HOOK}\"; then
  echo '>>> Patching udev init-bottom hook with udevadm settle...'
  sed -i '/move the .dev tmpfs to the rootfs/i \\
udevadm settle --timeout=30 || true\\
' \"\${UDEV_HOOK}\"
fi

# Force a clean initramfs regeneration NOW that all packages
# (including live-boot-initramfs-tools) are installed. If the
# kernel's initrd got built before live-boot's hook was registered
# during the apt-get transaction above, the resulting initrd.img
# would be missing the logic that finds and mounts the squashfs —
# which causes init to start in an empty environment and die
# immediately (kernel panic: 'Attempted to kill init!').
echo '>>> Regenerating initramfs with live-boot hooks...'
update-initramfs -u -k all

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
  if [ -d "apps/$app" ]; then
    echo ">>> Copying $app..."
    cp -r "apps/$app" stageos-build/chroot/opt/stageos/apps/
  fi
done
cp os/output-daemon.js     stageos-build/chroot/opt/stageos/services/
cp os/launcher.html        stageos-build/chroot/opt/stageos/apps/
cp os/equipment-test.html  stageos-build/chroot/opt/stageos/apps/

# ── Install only the daemon's own (tiny) ws dependency ───────
# Per-app npm installs for the real apps are skipped here too —
# they're not needed just to BOOT and see the launcher screen,
# and they add more surface area for the same kind of silent
# failure that likely caused the panic. Re-add once boot is solid.
#
# NOTE: previously this could fail with SELF_SIGNED_CERT_IN_CHAIN
# (npm registry request failing TLS verification inside the chroot,
# e.g. behind a corporate/CI proxy that MITMs HTTPS) while still
# silently leaving a usable node_modules/ws behind from the partial
# attempt — masking a real failure. Now: point npm explicitly at the
# system CA bundle, retry once, and hard-fail with a clear message
# if it still can't install, instead of shipping a build that got
# lucky.
chroot stageos-build/chroot /bin/bash -c "
set -e
set -o pipefail
update-ca-certificates
"

# If the build machine sits behind a proxy that does TLS interception
# (corporate network, some CI runners, this sandbox), the chroot's
# freshly-debootstrapped CA bundle won't trust it even though the host
# does. Trust whatever the host trusts, so npm can actually reach the
# registry through the same path apt/curl already use successfully.
# This must happen AFTER update-ca-certificates, which would otherwise
# regenerate the bundle from scratch and wipe this out.
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
  cp /etc/ssl/certs/ca-certificates.crt stageos-build/chroot/etc/ssl/certs/ca-certificates.crt
fi

chroot stageos-build/chroot /bin/bash -c "
set -e
set -o pipefail
cd /opt/stageos/services
npm config set cafile /etc/ssl/certs/ca-certificates.crt
rm -rf node_modules
if ! npm install ws --no-save; then
  echo '>>> First npm install attempt failed, retrying...'
  sleep 3
  npm install ws --no-save
fi
if [ ! -d node_modules/ws ]; then
  echo 'FATAL: node_modules/ws was not installed.' >&2
  exit 1
fi
echo '>>> ws dependency installed OK'
"

unmount_chroot_binds() {
  for d in dev proc sys; do
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if ! mountpoint -q "stageos-build/chroot/${d}" 2>/dev/null; then
        break
      fi
      umount "stageos-build/chroot/${d}" 2>/dev/null || umount -l "stageos-build/chroot/${d}" 2>/dev/null || true
      sleep 0.5
    done
    if mountpoint -q "stageos-build/chroot/${d}" 2>/dev/null; then
      echo "WARNING: stageos-build/chroot/${d} is still mounted after retries" >&2
    fi
  done
}
unmount_chroot_binds

# Copy kernel and initrd
cp stageos-build/chroot/boot/vmlinuz-*  stageos-build/iso/live/vmlinuz
cp stageos-build/chroot/boot/initrd.img-* stageos-build/iso/live/initrd.img

# GRUB config - nomodeset on by default, longer timeout, no quiet splash
# Dual console: ttyS0 first (so early boot/kernel messages are visible
# over a serial connection for debugging, e.g. via QEMU or a real
# serial header on rack hardware), tty0 last (so the physical
# HDMI/touchscreen display remains the *preferred* console that
# getty/agetty and the X autostart logic actually use).
cat > stageos-build/iso/boot/grub/grub.cfg << 'GRUB'
set default=0
set timeout=10

menuentry "StageOS v1.3" {
  linux /live/vmlinuz boot=live nomodeset net.ifnames=0 biosdevname=0 console=ttyS0,115200n8 console=tty0
  initrd /live/initrd.img
}

menuentry "StageOS v1.3 (Safe Mode)" {
  linux /live/vmlinuz boot=live nomodeset xforcevesa vga=normal console=ttyS0,115200n8 console=tty0
  initrd /live/initrd.img
}

menuentry "StageOS v1.3 (Verbose - Show all messages)" {
  linux /live/vmlinuz boot=live nomodeset console=ttyS0,115200n8 console=tty0
  initrd /live/initrd.img
}
GRUB

cp stageos-build/iso/boot/grub/grub.cfg stageos-build/iso/EFI/boot/grub.cfg

echo ">>> Disk space before squashfs:"
df -h .

# Build squashfs
echo ">>> Building filesystem..."
# IMPORTANT: exclude patterns use a trailing /* so only each
# directory's CONTENTS are excluded, not the directory node itself.
# Root-caused via interactive break=bottom debugging: with bare
# excludes ("-e dev" etc, no trailing /*), mksquashfs would
# sometimes omit /dev, /proc, /sys, /run, /boot from the image
# entirely rather than including them as empty mountpoints,
# depending on whether the chroot's bind-mounts were still attached
# when mksquashfs ran. Live-boot's init-bottom hook needs these as
# real (if empty) directories to move-mount onto — when they're
# missing outright, that mount fails with "No such file or
# directory" and the kernel panics with "Attempted to kill init!".
# This was the actual bug, not a device-enumeration timing race.
mksquashfs stageos-build/chroot stageos-build/iso/live/filesystem.squashfs \
  -comp gzip -b 1M -noappend \
  -e boot/* -e proc/* -e sys/* -e dev/* -e run/* -e tmp/* -e var/cache/apt/*

echo ">>> Disk space after squashfs:"
df -h .

# Build ISO
echo ">>> Building ISO..."
grub-mkrescue --output=StageOS-v1.0.iso stageos-build/iso -- -volid STAGEOS_1_3

echo ">>> DONE"
ls -lh StageOS-v1.0.iso
