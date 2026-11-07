/*
 * ==============================================================================
 * BATTLEBOT TELEMETRY - VOLTER PRIME PIEZO WIRELESS SYSTEM (WI-FI + USB)
 * ==============================================================================
 * 1. Wireless Communication:
 *    - Mode 1: Robot Hotspot (AP Mode) -> Creates Wi-Fi "VOLTER_PRIME_ARENA"
 *              Connect your laptop/phone to this Wi-Fi! No cables needed!
 *    - Mode 2: Station Mode (STA) -> Connects to arena router/phone hotspot.
 *    - Protocol: Ultra-low-latency UDP Broadcast on port 41234 (<1ms latency).
 *    - Dual-Link: Simultaneously transmits over USB Serial AND Wi-Fi!
 * 2. Piezo Sensor Logic (Unchanged & Calibrated):
 *    - Pin: GPIO 34 (ADC1_CH6) with ADC_0db (3x sensitivity boost)
 *    - Sampling Rate: 40,000+ reads/sec (Continuous zero-delay loop)
 *    - 15ms Peak Latch Window for mechanical shockwaves
 *    - Dynamic Rolling Baseline Tracking (~440 ADC)
 *    - Small Damage (-1 HP): Net spike >= +350 ADC (Peak >= 850 ADC)
 *    - Critical Smash (-3 HP): Net spike >= +1100 ADC (Peak >= 1600 ADC)
 *    - Debounce Cooldown: 250ms refractory period
 * ==============================================================================
 */

#include <WiFi.h>
#include <WiFiUdp.h>

// ==========================================
// WI-FI CONFIGURATION
// ==========================================
// Set to 'true' to have the Robot generate its own Wi-Fi Hotspot (Recommended for Arena!)
// Set to 'false' to connect to an existing Wi-Fi router / mobile hotspot
#define USE_ROBOT_HOTSPOT true

// Hotspot Settings (Robot creates this Wi-Fi network)
#define AP_SSID "VOLTER_PRIME_ARENA"
#define AP_PASS "volter1234"      // Minimum 8 characters for WPA2 (or "" for open network)

// Station Settings (If USE_ROBOT_HOTSPOT is false)
#define STA_SSID "YOUR_WIFI_NAME"
#define STA_PASS "YOUR_WIFI_PASSWORD"

#define UDP_PORT 41234
#define BAUD_RATE 115200

// ==========================================
// PIEZO SENSOR CONFIGURATION (UNCHANGED)
// ==========================================
#define PIEZO_PIN 34              // ESP32 Analog Input Pin (ADC1)
#define IMPACT_WINDOW_MS 15       // 15ms shockwave integration window to capture true peak
#define HIT_COOLDOWN_MS 250       // 250ms debounce between discrete hammer strikes
#define TELEMETRY_STREAM_MS 10    // 100 updates per second stream (10ms interval)

// Calibrated impact deltas above baseline
#define NET_SMALL_DELTA 350       // +350 ADC above resting baseline (e.g. 440 + 350 = 790 ADC)
#define NET_CRIT_DELTA  1100      // +1100 ADC above resting baseline (e.g. 440 + 1100 = 1540 ADC)

// State variables
float rollingBaseline = 440.0;    // Auto-calibrating resting baseline
bool isCapturingImpact = false;
unsigned long impactStartTime = 0;
int impactWindowMax = 0;
unsigned long lastRegisteredHitTime = 0;
unsigned long lastStreamTime = 0;
int streamPeak = 0;

// Wi-Fi Objects
WiFiUDP udp;
bool wifiActive = false;
IPAddress broadcastIp(192, 168, 4, 255);

void initWiFi() {
  if (USE_ROBOT_HOTSPOT) {
    // Mode 1: Create Wi-Fi Hotspot on Robot
    WiFi.mode(WIFI_AP);
    bool apSuccess = (strlen(AP_PASS) >= 8) ? WiFi.softAP(AP_SSID, AP_PASS) : WiFi.softAP(AP_SSID);
    delay(100);
    IPAddress myIP = WiFi.softAPIP();
    broadcastIp = IPAddress(192, 168, 4, 255);
    wifiActive = true;
    udp.begin(UDP_PORT);

    Serial.println("==================================================");
    Serial.println(">>> ROBOT WI-FI ACCESS POINT ACTIVE <<<");
    Serial.print(">>> SSID: "); Serial.println(AP_SSID);
    Serial.print(">>> PASS: "); Serial.println(strlen(AP_PASS) >= 8 ? AP_PASS : "(Open Network)");
    Serial.print(">>> ROBOT IP: "); Serial.println(myIP);
    Serial.print(">>> BROADCAST IP: "); Serial.println(broadcastIp);
    Serial.print(">>> UDP PORT: "); Serial.println(UDP_PORT);
    Serial.println("==================================================");
  } else {
    // Mode 2: Connect to Existing Wi-Fi
    WiFi.mode(WIFI_STA);
    WiFi.begin(STA_SSID, STA_PASS);
    Serial.print("Connecting to Wi-Fi: ");
    Serial.println(STA_SSID);
    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 20) {
      delay(250);
      Serial.print(".");
      retries++;
    }
    if (WiFi.status() == WL_CONNECTED) {
      wifiActive = true;
      broadcastIp = IPAddress(255, 255, 255, 255);
      udp.begin(UDP_PORT);
      Serial.println("\n>>> WI-FI CONNECTED! <<<");
      Serial.print(">>> IP Address: "); Serial.println(WiFi.localIP());
    } else {
      Serial.println("\n>>> Wi-Fi connection timed out. Starting Hotspot fallback... <<<");
      WiFi.mode(WIFI_AP);
      WiFi.softAP(AP_SSID, AP_PASS);
      broadcastIp = IPAddress(192, 168, 4, 255);
      wifiActive = true;
      udp.begin(UDP_PORT);
    }
  }
}

// Transmit packet over BOTH Serial (USB) and Wi-Fi UDP (Wireless)
void transmitTelemetry(const char* prefix, int val) {
  char msg[32];
  snprintf(msg, sizeof(msg), "%s:%d", prefix, val);

  // 1. USB Serial Output (if connected)
  Serial.println(msg);

  // 2. Wireless UDP Output
  if (wifiActive) {
    udp.beginPacket(broadcastIp, UDP_PORT);
    udp.println(msg);
    udp.endPacket();
  }
}

void setup() {
  Serial.begin(BAUD_RATE);
  pinMode(PIEZO_PIN, INPUT);

  // 0dB attenuation gives 3x hardware sensitivity boost (0 - 1.1V range on ESP32)
  #if defined(ESP32)
    analogSetAttenuation(ADC_0db);
  #endif

  // Initial calibration: sample 200 times to seed baseline
  long sum = 0;
  for (int i = 0; i < 200; i++) {
    sum += analogRead(PIEZO_PIN);
    delayMicroseconds(250);
  }
  rollingBaseline = (float)sum / 200.0;

  Serial.println("==================================================");
  Serial.println(">>> VOLTER PRIME HIGH-PRECISION IMPACT SYSTEM <<<");
  Serial.print(">>> CALIBRATED BASELINE: ");
  Serial.print((int)rollingBaseline);
  Serial.print(" ADC | BAUD: ");
  Serial.println(BAUD_RATE);
  Serial.println("==================================================");

  // Start Wireless Wi-Fi Link
  initWiFi();
}

void loop() {
  unsigned long now = millis();

  // 1. Ultra-fast ADC sampling (takes ~9.5 microseconds per read)
  int rawValue = analogRead(PIEZO_PIN);

  // Track peak for high-frequency oscilloscope stream
  if (rawValue > streamPeak) {
    streamPeak = rawValue;
  }

  // 2. Slow-moving rolling baseline tracking during quiet periods
  if (!isCapturingImpact && rawValue < (int)(rollingBaseline + 100)) {
    rollingBaseline = (rollingBaseline * 127.0 + rawValue) / 128.0;
  }

  int netDelta = rawValue - (int)rollingBaseline;

  // 3. Impact Detection & 15ms Window Peak Latch (Unchanged sensor logic)
  if (!isCapturingImpact) {
    // Check if real shockwave starts and cooldown has passed
    if (netDelta >= NET_SMALL_DELTA && (now - lastRegisteredHitTime > HIT_COOLDOWN_MS)) {
      isCapturingImpact = true;
      impactStartTime = now;
      impactWindowMax = rawValue;
    }
  } else {
    // Inside the 15ms impact window: latch the absolute highest mechanical shockwave peak!
    if (rawValue > impactWindowMax) {
      impactWindowMax = rawValue;
    }

    // Check if the 15ms window has completed
    if (now - impactStartTime >= IMPACT_WINDOW_MS) {
      isCapturingImpact = false;
      int truePeak = impactWindowMax;
      int netPeak = truePeak - (int)rollingBaseline;

      // Only evaluate and register if it ACTUALLY qualifies as a real impact strike
      if (netPeak >= NET_CRIT_DELTA || truePeak >= 1600) {
        // CRITICAL SMASH (-3 HP)
        lastRegisteredHitTime = now;
        transmitTelemetry("C", truePeak);
      } else if (netPeak >= NET_SMALL_DELTA || truePeak >= 850) {
        // SMALL DAMAGE (-1 HP)
        lastRegisteredHitTime = now;
        transmitTelemetry("S", truePeak);
      }

      streamPeak = 0;
    }
  }

  // 4. High-frequency continuous stream for oscilloscope (100 updates/sec)
  if (now - lastStreamTime >= TELEMETRY_STREAM_MS) {
    lastStreamTime = now;
    int sendVal = (streamPeak > 0) ? streamPeak : rawValue;
    
    // Fast compact packet
    transmitTelemetry("A", sendVal);

    streamPeak = 0;
  }

  // 5. Dynamic command listener from USB serial or Wi-Fi UDP
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "CALIB") {
      rollingBaseline = (float)rawValue;
      Serial.print("BASELINE_RESET: ");
      Serial.println((int)rollingBaseline);
    }
  }

  // Check incoming UDP commands (e.g. CALIB over Wi-Fi)
  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    char packetBuffer[64];
    int len = udp.read(packetBuffer, 63);
    if (len > 0) {
      packetBuffer[len] = 0;
      String cmd = String(packetBuffer);
      cmd.trim();
      if (cmd == "CALIB") {
        rollingBaseline = (float)rawValue;
        transmitTelemetry("BASELINE_RESET", (int)rollingBaseline);
      }
    }
  }
}
