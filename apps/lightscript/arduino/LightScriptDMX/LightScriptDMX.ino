/*
 * LightScript DMX Bridge
 * ──────────────────────────────────────────────────────────────────────────
 * Hardware: Arduino Uno/Mega + MAX485 (or RS485) DMX shield
 *
 * Wiring (MAX485 chip):
 *   Arduino Pin 2  → DE + RE (direction control, tied together)
 *   Arduino Pin 3  → TX to MAX485 DI pin   (use SoftwareSerial on Uno)
 *   MAX485 A/B     → DMX+ / DMX-  (XLR pin 3 / pin 2)
 *   MAX485 VCC     → 5V
 *   MAX485 GND     → GND
 *
 * For Arduino MEGA: use Serial1 (pins 18/19) instead of SoftwareSerial.
 * Change #define USE_MEGA to 1 below if using a Mega.
 *
 * Protocol from LightScript over USB Serial (115200 baud):
 *   Each packet: [0x7E] [universe_lo] [universe_hi] [ch1] [ch2] ... [ch512] [0xE7]
 *   Start byte : 0x7E
 *   Universe   : 2 bytes little-endian (e.g. universe 1 = 0x01 0x00)
 *   DMX data   : 512 bytes (channels 1–512)
 *   End byte   : 0xE7
 *   Total      : 516 bytes per packet
 *
 * The Arduino reads packets from USB, then fires DMX out at ~44fps.
 * LED on pin 13 blinks on each valid packet received.
 * ──────────────────────────────────────────────────────────────────────────
 */

#define USE_MEGA       0     // Set to 1 if using Arduino Mega (uses Serial1)
#define DMX_DIR_PIN    2     // MAX485 DE/RE direction pin
#define STATUS_LED     13    // Built-in LED
#define DMX_CHANNELS   512

// ── SoftwareSerial for Uno ────────────────────────────────────────────────
#if USE_MEGA == 0
  #include <SoftwareSerial.h>
  #define DMX_TX_PIN 3
  #define DMX_RX_PIN 4   // not used, DMX is TX-only
  SoftwareSerial dmxSerial(DMX_RX_PIN, DMX_TX_PIN);
#endif

// ── DMX buffer ────────────────────────────────────────────────────────────
uint8_t dmxBuffer[DMX_CHANNELS];
bool    newData       = false;
uint8_t recvBuf[516];
int     recvIdx       = 0;
bool    inPacket      = false;

// ── Timing ────────────────────────────────────────────────────────────────
unsigned long lastDMX       = 0;
const uint16_t DMX_INTERVAL = 23; // ~44 fps  (DMX spec min ~23ms per frame)

unsigned long lastBlink     = 0;
bool          ledState      = false;

// ─────────────────────────────────────────────────────────────────────────
void setup() {
  pinMode(DMX_DIR_PIN, OUTPUT);
  digitalWrite(DMX_DIR_PIN, HIGH); // Always transmit

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // USB serial — receives packets from LightScript
  Serial.begin(115200);

  // DMX serial — 250000 baud, 8N2
#if USE_MEGA
  Serial1.begin(250000, SERIAL_8N2);
#else
  dmxSerial.begin(250000);
  // SoftwareSerial doesn't support 8N2 natively, but most MAX485 shields
  // are fine with 8N1 at 250k for short cable runs. For strict DMX512
  // compliance on long runs, use a Mega or dedicated DMX shield with hardware serial.
#endif

  // Clear DMX buffer
  memset(dmxBuffer, 0, DMX_CHANNELS);

  Serial.println(F("LightScript DMX Bridge v1.0 ready"));
  Serial.println(F("Waiting for packets on USB serial..."));
}

// ─────────────────────────────────────────────────────────────────────────
void loop() {
  readSerial();

  unsigned long now = millis();

  // Send DMX frame at ~44fps regardless of new data (keeps fixture refresh alive)
  if (now - lastDMX >= DMX_INTERVAL) {
    lastDMX = now;
    sendDMXFrame();
  }

  // Blink LED on new packet
  if (newData) {
    newData  = false;
    ledState = !ledState;
    digitalWrite(STATUS_LED, ledState);
  }
}

// ── Read and parse incoming packets from LightScript ─────────────────────
void readSerial() {
  while (Serial.available() > 0) {
    uint8_t b = Serial.read();

    if (!inPacket) {
      if (b == 0x7E) {        // Start of packet
        inPacket = true;
        recvIdx  = 0;
      }
      continue;
    }

    // We're inside a packet
    recvBuf[recvIdx++] = b;

    // Full packet body received (515 bytes after the 0x7E start)
    if (recvIdx >= 515) {
      if (recvBuf[514] == 0xE7) {  // Valid end byte
        // Bytes 0–1: universe (little-endian, currently ignored — single universe)
        // Bytes 2–513: DMX channels 1–512
        memcpy(dmxBuffer, recvBuf + 2, DMX_CHANNELS);
        newData = true;

        // Acknowledge back to LightScript
        Serial.write(0xAC);
      } else {
        // Bad packet — report error
        Serial.println(F("ERR:bad_packet"));
      }
      inPacket = false;
      recvIdx  = 0;
    }

    // Overrun guard
    if (recvIdx >= 516) {
      inPacket = false;
      recvIdx  = 0;
    }
  }
}

// ── Send a full DMX512 frame via the MAX485 ───────────────────────────────
void sendDMXFrame() {
  // DMX BREAK: pull line low for ≥92µs
  // We do this by temporarily switching to a slower baud rate and sending 0x00
#if USE_MEGA
  Serial1.end();
  pinMode(18, OUTPUT);          // TX1 pin on Mega
  digitalWrite(18, LOW);
  delayMicroseconds(110);       // BREAK (≥92µs)
  digitalWrite(18, HIGH);
  delayMicroseconds(12);        // Mark After Break (≥12µs)
  Serial1.begin(250000, SERIAL_8N2);
#else
  // SoftwareSerial break approximation
  dmxSerial.end();
  pinMode(DMX_TX_PIN, OUTPUT);
  digitalWrite(DMX_TX_PIN, LOW);
  delayMicroseconds(110);
  digitalWrite(DMX_TX_PIN, HIGH);
  delayMicroseconds(12);
  dmxSerial.begin(250000);
#endif

  // Start code (0x00 = standard dimmer)
#if USE_MEGA
  Serial1.write((uint8_t)0x00);
  Serial1.write(dmxBuffer, DMX_CHANNELS);
  Serial1.flush();
#else
  dmxSerial.write((uint8_t)0x00);
  dmxSerial.write(dmxBuffer, DMX_CHANNELS);
#endif
}
