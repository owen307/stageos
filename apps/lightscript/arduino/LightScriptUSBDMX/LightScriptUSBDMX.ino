/*
 * LightScript Arduino USB-DMX Bridge
 * ════════════════════════════════════════════════════════════════════════════
 * Makes an Arduino with a MAX485 / RS485 chip appear as an Enttec USB DMX Pro
 * to LightScript (and any other software that uses the Enttec Widget API).
 *
 * Compatible boards (have native USB-CDC):
 *   Arduino Leonardo, Micro, Pro Micro, Due, Zero, MKR series
 *   Teensy 2.0 / 3.x / 4.x  (set USB type = "Serial" in Tools menu)
 *
 * ─── NOT compatible with Uno / Mega ────────────────────────────────────────
 *   Those use a separate USB chip (ATmega16U2) for serial bridging.
 *   On those boards the USB-CDC baud rate is ignored at the device level,
 *   so the Enttec Widget API won't work. Use a Leonardo or Pro Micro.
 *
 * ─── Wiring ────────────────────────────────────────────────────────────────
 *   Arduino Pin 2  →  MAX485 DE + RE  (tied together — always transmit)
 *   Arduino Pin 1  →  MAX485 DI       (hardware TX pin)
 *   MAX485 A       →  XLR Pin 3       (DMX+)
 *   MAX485 B       →  XLR Pin 2       (DMX−)
 *   XLR Pin 1      →  GND             (shield)
 *   MAX485 VCC     →  5V
 *   MAX485 GND     →  GND
 *
 * ─── Enttec USB DMX Pro Widget API (simplified) ────────────────────────────
 *   All packets:   [0x7E] [label] [len_lo] [len_hi] [data...] [0xE7]
 *
 *   Label 3  →  Get Widget Parameters (we respond with firmware version)
 *   Label 6  →  Send DMX Packet       (we output DMX512 on the RS485 line)
 *   Label 10 →  Get Widget Serial Number (we return a fake serial)
 *
 * ─── In LightScript ────────────────────────────────────────────────────────
 *   1. Open USB DMX Settings (⚙ button next to DMX OFF)
 *   2. Select interface type: Enttec USB DMX Pro
 *   3. Refresh ports — the Arduino shows up as "usbmodem" or "usbserial"
 *   4. Select it and click Connect
 * ════════════════════════════════════════════════════════════════════════════
 */

#include <Arduino.h>

// ── Pins ──────────────────────────────────────────────────────────────────
#define DMX_DIR_PIN  2    // MAX485 direction — HIGH = transmit
#define STATUS_LED   LED_BUILTIN

// ── Enttec Widget API constants ────────────────────────────────────────────
#define PKT_START    0x7E
#define PKT_END      0xE7
#define LABEL_GET_PARAMS   3
#define LABEL_SEND_DMX     6
#define LABEL_GET_SERIAL   10

// ── DMX ───────────────────────────────────────────────────────────────────
#define DMX_CHANNELS 512
uint8_t dmxBuffer[DMX_CHANNELS];
bool    newFrame   = false;

// ── Parser state ──────────────────────────────────────────────────────────
enum ParseState { WAIT_START, WAIT_LABEL, WAIT_LEN_LO, WAIT_LEN_HI, READING_DATA, WAIT_END };
ParseState pState   = WAIT_START;
uint8_t    pLabel   = 0;
uint16_t   pLenExpected = 0;
uint16_t   pLenRead = 0;
uint8_t    pData[520]; // max packet size

// ── Timing ────────────────────────────────────────────────────────────────
unsigned long lastDMXTime = 0;
const uint16_t DMX_MIN_INTERVAL_MS = 22;  // ~44 fps max

// ─────────────────────────────────────────────────────────────────────────
void setup() {
  pinMode(DMX_DIR_PIN, OUTPUT);
  digitalWrite(DMX_DIR_PIN, HIGH); // Always transmit

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // USB CDC — speed doesn't matter for Leonardo/Micro (native USB ignores baud)
  Serial.begin(115200);

  // Hardware serial for DMX at 250kbaud 8N2
  Serial1.begin(250000, SERIAL_8N2);

  memset(dmxBuffer, 0, DMX_CHANNELS);

  // Wait for USB connection (Leonardo/Micro only)
  while (!Serial && millis() < 3000) {}
}

// ─────────────────────────────────────────────────────────────────────────
void loop() {
  parseIncoming();

  unsigned long now = millis();
  if (newFrame && (now - lastDMXTime >= DMX_MIN_INTERVAL_MS)) {
    lastDMXTime = now;
    newFrame    = false;
    sendDMXFrame();
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED)); // blink
  }
}

// ── Parse USB → Enttec Widget API packets ─────────────────────────────────
void parseIncoming() {
  while (Serial.available() > 0) {
    uint8_t b = (uint8_t)Serial.read();
    switch (pState) {

      case WAIT_START:
        if (b == PKT_START) pState = WAIT_LABEL;
        break;

      case WAIT_LABEL:
        pLabel  = b;
        pState  = WAIT_LEN_LO;
        break;

      case WAIT_LEN_LO:
        pLenExpected = b;
        pState = WAIT_LEN_HI;
        break;

      case WAIT_LEN_HI:
        pLenExpected |= ((uint16_t)b << 8);
        pLenRead = 0;
        if (pLenExpected == 0) {
          pState = WAIT_END;
        } else {
          pState = READING_DATA;
        }
        break;

      case READING_DATA:
        if (pLenRead < sizeof(pData)) pData[pLenRead] = b;
        pLenRead++;
        if (pLenRead >= pLenExpected) pState = WAIT_END;
        break;

      case WAIT_END:
        if (b == PKT_END) handlePacket();
        // Either way, reset
        pState = WAIT_START;
        break;
    }
  }
}

// ── Dispatch received packet by label ─────────────────────────────────────
void handlePacket() {
  switch (pLabel) {

    case LABEL_SEND_DMX:
      // Data[0] is DMX start code (should be 0x00)
      // Data[1..512] are channels 1-512
      if (pLenRead >= 2) {
        uint16_t chCount = min((uint16_t)(pLenRead - 1), (uint16_t)DMX_CHANNELS);
        memcpy(dmxBuffer, pData + 1, chCount);
        // Zero any channels not in this packet
        if (chCount < DMX_CHANNELS) memset(dmxBuffer + chCount, 0, DMX_CHANNELS - chCount);
        newFrame = true;
      }
      break;

    case LABEL_GET_PARAMS:
      // Respond: firmware version, break time, MAB time, output rate
      sendResponse(LABEL_GET_PARAMS, (uint8_t[]){0x01, 0x00, 0x09, 0x01, 0x28}, 5);
      break;

    case LABEL_GET_SERIAL:
      // Return a fake 4-byte serial number
      sendResponse(LABEL_GET_SERIAL, (uint8_t[]){0x4C, 0x53, 0x01, 0x00}, 4);
      break;

    default:
      // Unknown label — ACK with empty response
      sendResponse(pLabel, nullptr, 0);
      break;
  }
}

// ── Send a Widget API response packet back over USB ──────────────────────
void sendResponse(uint8_t label, const uint8_t* data, uint16_t len) {
  Serial.write(PKT_START);
  Serial.write(label);
  Serial.write((uint8_t)(len & 0xFF));
  Serial.write((uint8_t)(len >> 8));
  if (data && len > 0) Serial.write(data, len);
  Serial.write(PKT_END);
}

// ── Output one DMX512 frame via MAX485 ────────────────────────────────────
void sendDMXFrame() {
  // Generate BREAK: pull line low ≥ 92µs using baud-rate trick
  // Switch to a slow baud rate, send 0x00 (which holds line low for a full byte period)
  Serial1.end();
  Serial1.begin(83333, SERIAL_8N1); // 1 / 83333 ≈ 12µs per bit → 10 bits = 120µs break
  Serial1.write((uint8_t)0x00);
  Serial1.flush();

  // Mark After Break: line high ≥ 12µs
  Serial1.end();
  Serial1.begin(250000, SERIAL_8N2);
  delayMicroseconds(8); // extra margin

  // Start code + 512 channels
  Serial1.write((uint8_t)0x00); // DMX start code
  Serial1.write(dmxBuffer, DMX_CHANNELS);
  Serial1.flush();
}
