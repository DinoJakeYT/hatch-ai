// Hatch starter: a 2D game window with Win32 + GDI (built into Windows, nothing to download).
// Build: cl -nologo -EHsc -std:c++17 -O2 main.cpp -Fe:game.exe user32.lib gdi32.lib -link -subsystem:windows
// Controls: arrow keys move, Esc quits. Collect the yellow coins.
// Change Update() for game rules and Render() for what's drawn.
#include <windows.h>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static bool g_running = true;
static bool g_keys[256] = {};
static int W = 800, H = 600;

struct Player { float x = 400, y = 300, size = 28, speed = 260; };
struct Coin { float x, y; };

static Player player;
static std::vector<Coin> coins;
static int score = 0;

static Coin RandomCoin() { return { 30.0f + std::rand() % (W - 60), 30.0f + std::rand() % (H - 60) }; }

static void Setup() {
    for (int i = 0; i < 6; i++) coins.push_back(RandomCoin());
}

static void Update(float dt) {
    if (g_keys[VK_LEFT]) player.x -= player.speed * dt;
    if (g_keys[VK_RIGHT]) player.x += player.speed * dt;
    if (g_keys[VK_UP]) player.y -= player.speed * dt;
    if (g_keys[VK_DOWN]) player.y += player.speed * dt;
    player.x = std::fmax(0, std::fmin((float)W - player.size, player.x));
    player.y = std::fmax(0, std::fmin((float)H - player.size, player.y));

    for (Coin& c : coins) {
        float dx = c.x - (player.x + player.size / 2), dy = c.y - (player.y + player.size / 2);
        if (dx * dx + dy * dy < 24 * 24) { score++; c = RandomCoin(); }
    }
}

// Draws into an off-screen bitmap first, then copies it to the window (no flicker).
static void Render(HDC dc) {
    HDC mem = CreateCompatibleDC(dc);
    HBITMAP bmp = CreateCompatibleBitmap(dc, W, H);
    HGDIOBJ old = SelectObject(mem, bmp);

    RECT all = { 0, 0, W, H };
    HBRUSH bg = CreateSolidBrush(RGB(24, 28, 40));
    FillRect(mem, &all, bg);
    DeleteObject(bg);

    HBRUSH gold = CreateSolidBrush(RGB(250, 200, 40));
    HGDIOBJ oldBrush = SelectObject(mem, gold);
    for (const Coin& c : coins) Ellipse(mem, (int)c.x - 10, (int)c.y - 10, (int)c.x + 10, (int)c.y + 10);
    SelectObject(mem, oldBrush);
    DeleteObject(gold);

    RECT p = { (int)player.x, (int)player.y, (int)(player.x + player.size), (int)(player.y + player.size) };
    HBRUSH green = CreateSolidBrush(RGB(60, 200, 110));
    FillRect(mem, &p, green);
    DeleteObject(green);

    char text[64];
    std::snprintf(text, sizeof(text), "Score: %d", score);
    SetBkMode(mem, TRANSPARENT);
    SetTextColor(mem, RGB(255, 255, 255));
    TextOutA(mem, 12, 10, text, (int)std::strlen(text));

    BitBlt(dc, 0, 0, W, H, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CLOSE: g_running = false; return 0;
    case WM_SIZE: if (LOWORD(lp) && HIWORD(lp)) { W = LOWORD(lp); H = HIWORD(lp); } return 0;
    case WM_KEYDOWN: if (wp < 256) g_keys[wp] = true; if (wp == VK_ESCAPE) g_running = false; return 0;
    case WM_KEYUP: if (wp < 256) g_keys[wp] = false; return 0;
    case WM_KILLFOCUS: for (bool& k : g_keys) k = false; return 0;
    case WM_ERASEBKGND: return 1;   // we paint everything ourselves
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE, LPSTR, int) {
    std::srand((unsigned)GetTickCount());
    WNDCLASSA wc = {};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.lpszClassName = "HatchGame2D";
    RegisterClassA(&wc);

    RECT r = { 0, 0, W, H };
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    HWND hwnd = CreateWindowA("HatchGame2D", "My 2D Game", WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT,
                              r.right - r.left, r.bottom - r.top, nullptr, nullptr, inst, nullptr);

    Setup();
    auto last = std::chrono::steady_clock::now();
    while (g_running) {
        MSG msg;
        while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) g_running = false;
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
        auto now = std::chrono::steady_clock::now();
        float dt = std::chrono::duration<float>(now - last).count();
        last = now;
        if (dt > 0.1f) dt = 0.1f;

        Update(dt);
        HDC dc = GetDC(hwnd);
        Render(dc);
        ReleaseDC(hwnd, dc);
        Sleep(1);
    }
    DestroyWindow(hwnd);
    return 0;
}
