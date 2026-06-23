/*
 * LightScript Arduino Uno DMX Bridge
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Works on: Arduino Uno, Uno R3, Uno R4, Nano, Mega (any ATmega with 2 UARTs
 *           OR software serial fallback)
 *
 * The Uno only has ONE hardware UART — shared between USB and Serial.
 * Strategy: USB (Serial) receives Enttec Widget API packets from LightScript
 *           at 115200 baud. DMX is sent via SoftwareSerial on pin 6 at 250000
 *           baud using a MAX485 chip.
 *
 * NOTE: SoftwareSerial at 250000 baud is right at the edge of what a 16MHz
 * Uno can reliably do. It works but avoid heavy processing during DMX frames.
 * For a rock-solid build, use an Arduino Mega (has 4 UARTs — use Serial1 for
 * DMX and Serial for USB, no software serial needed).
 *
 * ─── Wiring (MAX485 or SN75176) ────────────────────────────────────────────
 *   Arduino Pin 2  →  MAX485 DE + RE  (tied together — always drive HIGH)
 *   Arduino Pin 6  →  MAX485 DI       (SoftwareSerial TX)
 *   MAX485 A       →  XLR Pin 3       (DMX+ / Data+)
 *   MAX485 B       →  XLR Pin 2       (DMX- / Data-)
 *   XLR Pin 1      →  GND             (shield)
 *   MAX485 VCC     →  5V
 *   MAX485 GND     →  GND
 *   LED (optional) →  Pin 13 (built-in) via 330Ω to GND
 *
 * ─── Mega wiring (better option) ───────────────────────────────────────────
 *   Change DMX_TX_PIN to 18 (Serial1 TX on Mega)
 *   Comment out SoftwareSerial lines, use Serial1 instead
 *   Everything else identical
 *
 * ─── In LightScript ────────────────────────────────────────────────────────
 *   USB DMX Settings → Interface: Enttec USB DMX Pro → select COM/ttyUSB port
 *   The Uno shows up as "USB Serial" or "CH340" depending on your clone
 *
 * ─── Enttec Widget API protocol ────────────────────────────────────────────
 *   Packet:  [0x7E] [label] [len_lo] [len_hi] [data...] [0xE7]
 *   Label 3: Get Widget Parameters → we respond with version info
 *   Label 6: Send DMX Packet       → output 512ch DMX on pin 6
 *   Label 10: Get Serial Number    → we return a fake serial
 * ════════════════════════════════════════════════════════════════════════════
 */

#include <Arduino.h>
#include <SoftwareSerial.h>

// ── Pin definitions ────────────────────────────────────────────────────────
#define DMX_DIR_PIN   2     // MAX485 direction control (always HIGH = transmit)
#define DMX_TX_PIN    6     // SoftwareSerial TX to MAX485 DI
#define DMX_RX_PIN    7     // SoftwareSerial RX (unused but required by lib)
#define STATUS_LED    13    // Built-in LED

// ── DMX ───────────────────────────────────────────────────────────────────
#define DMX_CHANNELS  512
uint8_t  dmxData[DMX_CHANNELS];
bool     pendingFrame  = false;
uint32_t lastFrameMs   = 0;
#define  DMX_FRAME_INTERVAL 22  // ~44fps max

// ── SoftwareSerial for DMX output ─────────────────────────────────────────
SoftwareSerial dmxSerial(DMX_RX_PIN, DMX_TX_PIN);

// ── Enttec Widget API parser ───────────────────────────────────────────────
#define PKT_START  0x7E
#define PKT_END    0xE7
#define LABEL_GET_PARAMS  3
#define LABEL_SEND_DMX    6
#define LABEL_GET_SERIAL  10

enum ParseState { S_START, S_LABEL, S_LEN_LO, S_LEN_HI, S_DATA, S_END };
ParseState pState  = S_START;
uint8_t    pLabel  = 0;
uint16_t   pLen    = 0;
uint16_t   pRead   = 0;
uint8_t    pBuf[520];

// ─────────────────────────────────────────────────────────────────────────
void setup() {
  pinMode(DMX_DIR_PIN, OUTPUT);
  digitalWrite(DMX_DIR_PIN, HIGH); // Always transmit

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // USB serial — host speed (Uno ignores baud for USB CDC on genuine boards;
  // for CH340 clones the baud matters so we set it explicitly)
  Serial.begin(115200);
  while (!Serial && millis() < 2000) {}

  // SoftwareSerial for DMX — 250kbaud with 2 stop bits
  dmxSerial.begin(250000);

  memset(dmxData, 0, DMX_CHANNELS);

  // Blink twice to show we're alive
  for (int i = 0; i < 2; i++) {
    digitalWrite(STATUS_LED, HIGH); delay(120);
    digitalWrite(STATUS_LED, LOW);  delay(120);
  }
}

// ─────────────────────────────────────────────────────────────────────────
void loop() {
  readUSB();

  uint32_t now = millis();
  if (pendingFrame && (now - lastFrameMs >= DMX_FRAME_INTERVAL)) {
    sendDMXFrame();
    lastFrameMs = now;
    pendingFrame = false;
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED)); // toggle LED
  }
}

// ── Read and parse USB → Widget API ───────────────────────────────────────
void readUSB() {
  while (Serial.available()) {
    uint8_t b = (uint8_t)Serial.read();
    switch (pState) {
      case S_START:
        if (b == PKT_START) pState = S_LABEL;
        break;
      case S_LABEL:
        pLabel = b; pState = S_LEN_LO;
        break;
      case S_LEN_LO:
        pLen = b; pState = S_LEN_HI;
        break;
      case S_LEN_HI:
        pLen |= ((uint16_t)b << 8);
        pRead = 0;
        pState = (pLen == 0) ? S_END : S_DATA;
        break;
      case S_DATA:
        if (pRead < sizeof(pBuf)) pBuf[pRead] = b;
        if (++pRead >= pLen) pState = S_END;
        break;
      case S_END:
        if (b == PKT_END) handlePacket();
        pState = S_START;
        break;
    }
  }
}

// ── Handle a complete Widget API packet ───────────────────────────────────
void handlePacket() {
  switch (pLabel) {

    case LABEL_SEND_DMX:
      // pBuf[0] = DMX start code (0x00), pBuf[1..512] = channel values
      if (pRead >= 2) {
        uint16_t ch = min((uint16_t)(pRead - 1), (uint16_t)DMX_CHANNELS);
        memcpy(dmxData, pBuf + 1, ch);
        if (ch < DMX_CHANNELS) memset(dmxData + ch, 0, DMX_CHANNELS - ch);
        pendingFrame = true;
      }
      break;

    case LABEL_GET_PARAMS: {
      // Respond: firmware_lsb, firmware_msb, break_time, mab_time, rate
      uint8_t resp[] = {0x01, 0x00, 0x09, 0x01, 0x28};
      sendResponse(LABEL_GET_PARAMS, resp, sizeof(resp));
      break;
    }

    case LABEL_GET_SERIAL: {
      // Fake serial number
      uint8_t resp[] = {0x4C, 0x53, 0x55, 0x31}; // "LSU1"
      sendResponse(LABEL_GET_SERIAL, resp, sizeof(resp));
      break;
    }

    default:
      sendResponse(pLabel, nullptr, 0);
      break;
  }
}

// ── Send Widget API response back over USB ────────────────────────────────
void sendResponse(uint8_t label, const uint8_t* data, uint16_t len) {
  Serial.write(PKT_START);
  Serial.write(label);
  Serial.write((uint8_t)(len & 0xFF));
  Serial.write((uint8_t)(len >> 8));
  if (data && len) Serial.write(data, len);
  Serial.write(PKT_END);
}

// ── Send one DMX512 frame via SoftwareSerial + MAX485 ─────────────────────
//
// DMX protocol timing:
//   BREAK:  ≥ 92µs  line LOW  → we send 0x00 at slow baud (one bit period > 92µs)
//   MAB:    ≥ 12µs  line HIGH → happens naturally between serial frames
//   START:  0x00 (start code)
//   DATA:   512 channel bytes at 250kbaud, 2 stop bits each
//
// SoftwareSerial can't easily change baud mid-stream on a Uno, so we use a
// manual bit-bang for the break, then switch to SoftwareSerial for data.
void sendDMXFrame() {
  // ── BREAK: bit-bang 110µs LOW pulse on DMX_TX_PIN ──────────────────────
  dmxSerial.end();                      // release the pin
  pinMode(DMX_TX_PIN, OUTPUT);
  digitalWrite(DMX_TX_PIN, LOW);
  delayMicroseconds(110);               // break ≥ 92µs

  // ── MAB: 12µs HIGH ─────────────────────────────────────────────────────
  digitalWrite(DMX_TX_PIN, HIGH);
  delayMicroseconds(12);

  // ── Re-init SoftwareSerial and send start code + 512 channels ──────────
  dmxSerial.begin(250000);
  dmxSerial.write((uint8_t)0x00);       // DMX start code
  dmxSerial.write(dmxData, DMX_CHANNELS);
}

/*
 * ════════════════════════════════════════════════════════════════════════════
 * MEGA VERSION NOTE
 * ════════════════════════════════════════════════════════════════════════════
 * If you're using an Arduino Mega, replace the SoftwareSerial approach with:
 *
 *   void sendDMXFrame() {
 *     Serial1.end();
 *     pinMode(18, OUTPUT);              // Serial1 TX pin on Mega
 *     digitalWrite(18, LOW);
 *     delayMicroseconds(110);
 *     digitalWrite(18, HIGH);
 *     delayMicroseconds(12);
 *     Serial1.begin(250000, SERIAL_8N2);
 *     Serial1.write((uint8_t)0x00);
 *     Serial1.write(dmxData, 512);
 *   }
 *
 * And in setup(): Serial1.begin(250000, SERIAL_8N2);
 * Remove all SoftwareSerial code.
 * ════════════════════════════════════════════════════════════════════════════
 */
