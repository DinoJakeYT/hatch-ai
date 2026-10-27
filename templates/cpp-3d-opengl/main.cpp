// Hatch starter: a 3D game window with Win32 + OpenGL (both built into Windows, nothing to download).
// Build: cl -nologo -EHsc -std:c++17 -O2 main.cpp -Fe:game.exe user32.lib gdi32.lib opengl32.lib glu32.lib -link -subsystem:windows
// Controls: W/A/S/D move, arrow keys look around, Space/Ctrl up/down, Esc quits.
// Change Update() for game rules and Render() for what's drawn.
#include <windows.h>
#include <GL/gl.h>
#include <GL/glu.h>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

static bool g_running = true;
static bool g_keys[256] = {};
static int g_width = 1280, g_height = 720;

struct Camera {
    float x = 0, y = 1.6f, z = 8;   // position
    float yaw = 0, pitch = 0;       // radians
};
static Camera cam;

struct Box {
    float x, y, z, size;
    float r, g, b;
};
static std::vector<Box> boxes;

// A unit cube centered on the origin, with normals so lighting works.
static void DrawUnitCube() {
    glBegin(GL_QUADS);
    glNormal3f(1, 0, 0);  glVertex3f(0.5f, -0.5f, -0.5f); glVertex3f(0.5f, 0.5f, -0.5f); glVertex3f(0.5f, 0.5f, 0.5f);  glVertex3f(0.5f, -0.5f, 0.5f);
    glNormal3f(-1, 0, 0); glVertex3f(-0.5f, -0.5f, 0.5f); glVertex3f(-0.5f, 0.5f, 0.5f); glVertex3f(-0.5f, 0.5f, -0.5f); glVertex3f(-0.5f, -0.5f, -0.5f);
    glNormal3f(0, 1, 0);  glVertex3f(-0.5f, 0.5f, -0.5f); glVertex3f(-0.5f, 0.5f, 0.5f); glVertex3f(0.5f, 0.5f, 0.5f);  glVertex3f(0.5f, 0.5f, -0.5f);
    glNormal3f(0, -1, 0); glVertex3f(-0.5f, -0.5f, 0.5f); glVertex3f(-0.5f, -0.5f, -0.5f); glVertex3f(0.5f, -0.5f, -0.5f); glVertex3f(0.5f, -0.5f, 0.5f);
    glNormal3f(0, 0, 1);  glVertex3f(-0.5f, -0.5f, 0.5f); glVertex3f(0.5f, -0.5f, 0.5f); glVertex3f(0.5f, 0.5f, 0.5f);  glVertex3f(-0.5f, 0.5f, 0.5f);
    glNormal3f(0, 0, -1); glVertex3f(0.5f, -0.5f, -0.5f); glVertex3f(-0.5f, -0.5f, -0.5f); glVertex3f(-0.5f, 0.5f, -0.5f); glVertex3f(0.5f, 0.5f, -0.5f);
    glEnd();
}

static void DrawBox(float x, float y, float z, float size, float r, float g, float b, float spinDegrees = 0) {
    glPushMatrix();
    glTranslatef(x, y, z);
    glRotatef(spinDegrees, 0, 1, 0);
    glScalef(size, size, size);
    glColor3f(r, g, b);
    DrawUnitCube();
    glPopMatrix();
}

static void DrawGround() {
    glColor3f(0.25f, 0.55f, 0.3f);
    glBegin(GL_QUADS);
    glNormal3f(0, 1, 0);
    glVertex3f(-50, 0, -50); glVertex3f(-50, 0, 50); glVertex3f(50, 0, 50); glVertex3f(50, 0, -50);
    glEnd();
    glDisable(GL_LIGHTING);   // grid lines on top of the ground
    glColor3f(0.2f, 0.45f, 0.25f);
    glBegin(GL_LINES);
    for (int i = -50; i <= 50; i += 2) {
        glVertex3f((float)i, 0.01f, -50); glVertex3f((float)i, 0.01f, 50);
        glVertex3f(-50, 0.01f, (float)i); glVertex3f(50, 0.01f, (float)i);
    }
    glEnd();
    glEnable(GL_LIGHTING);
}

static void Setup() {
    for (int i = 0; i < 12; i++) {
        float a = i * 3.14159f * 2 / 12;
        boxes.push_back({ std::cos(a) * 10, 0.75f, std::sin(a) * 10, 1.5f, 0.9f, 0.5f + 0.04f * i, 0.2f });
    }
}

static void Update(float dt) {
    const float moveSpeed = 6.0f, turnSpeed = 1.8f;
    float fx = std::sin(cam.yaw), fz = -std::cos(cam.yaw);   // forward on the ground
    float rx = std::cos(cam.yaw), rz = std::sin(cam.yaw);    // right
    if (g_keys['W']) { cam.x += fx * moveSpeed * dt; cam.z += fz * moveSpeed * dt; }
    if (g_keys['S']) { cam.x -= fx * moveSpeed * dt; cam.z -= fz * moveSpeed * dt; }
    if (g_keys['D']) { cam.x += rx * moveSpeed * dt; cam.z += rz * moveSpeed * dt; }
    if (g_keys['A']) { cam.x -= rx * moveSpeed * dt; cam.z -= rz * moveSpeed * dt; }
    if (g_keys[VK_SPACE]) cam.y += moveSpeed * dt;
    if (g_keys[VK_CONTROL] && cam.y > 0.5f) cam.y -= moveSpeed * dt;
    if (g_keys[VK_LEFT]) cam.yaw -= turnSpeed * dt;
    if (g_keys[VK_RIGHT]) cam.yaw += turnSpeed * dt;
    if (g_keys[VK_UP] && cam.pitch < 1.4f) cam.pitch += turnSpeed * dt;
    if (g_keys[VK_DOWN] && cam.pitch > -1.4f) cam.pitch -= turnSpeed * dt;
}

static void Render(float time) {
    glViewport(0, 0, g_width, g_height);
    glClearColor(0.53f, 0.75f, 0.95f, 1);   // sky
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    gluPerspective(70.0, (double)g_width / g_height, 0.1, 500.0);

    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    glRotatef(-cam.pitch * 57.2958f, 1, 0, 0);
    glRotatef(cam.yaw * 57.2958f, 0, 1, 0);
    glTranslatef(-cam.x, -cam.y, -cam.z);

    GLfloat sun[] = { 0.4f, 1.0f, 0.6f, 0.0f };   // directional light, set after the camera
    glLightfv(GL_LIGHT0, GL_POSITION, sun);

    DrawGround();
    for (const Box& b : boxes) DrawBox(b.x, b.y, b.z, b.size, b.r, b.g, b.b);
    DrawBox(0, 1.5f + std::sin(time * 2) * 0.4f, 0, 1.2f, 0.85f, 0.2f, 0.25f, time * 60);   // a floating, spinning cube
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_CLOSE: g_running = false; return 0;
    case WM_SIZE: g_width = LOWORD(lp); g_height = HIWORD(lp) ? HIWORD(lp) : 1; return 0;
    case WM_KEYDOWN: if (wp < 256) g_keys[wp] = true; if (wp == VK_ESCAPE) g_running = false; return 0;
    case WM_KEYUP: if (wp < 256) g_keys[wp] = false; return 0;
    case WM_KILLFOCUS: for (bool& k : g_keys) k = false; return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE, LPSTR, int) {
    WNDCLASSA wc = {};
    wc.style = CS_OWNDC;
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.lpszClassName = "HatchGame3D";
    RegisterClassA(&wc);

    RECT r = { 0, 0, g_width, g_height };
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    HWND hwnd = CreateWindowA("HatchGame3D", "My 3D Game", WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT,
                              r.right - r.left, r.bottom - r.top, nullptr, nullptr, inst, nullptr);
    HDC dc = GetDC(hwnd);

    PIXELFORMATDESCRIPTOR pfd = {};
    pfd.nSize = sizeof(pfd);
    pfd.nVersion = 1;
    pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    pfd.iPixelType = PFD_TYPE_RGBA;
    pfd.cColorBits = 32;
    pfd.cDepthBits = 24;
    pfd.iLayerType = PFD_MAIN_PLANE;
    SetPixelFormat(dc, ChoosePixelFormat(dc, &pfd), &pfd);
    HGLRC rc = wglCreateContext(dc);
    wglMakeCurrent(dc, rc);

    glEnable(GL_DEPTH_TEST);
    glEnable(GL_LIGHTING);
    glEnable(GL_LIGHT0);
    glEnable(GL_COLOR_MATERIAL);
    glEnable(GL_NORMALIZE);
    GLfloat ambient[] = { 0.35f, 0.35f, 0.4f, 1 };
    glLightModelfv(GL_LIGHT_MODEL_AMBIENT, ambient);

    Setup();
    auto last = std::chrono::steady_clock::now();
    float time = 0, fpsTimer = 0;
    int frames = 0;
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
        time += dt;

        Update(dt);
        Render(time);
        SwapBuffers(dc);

        frames++;
        fpsTimer += dt;
        if (fpsTimer >= 1) {   // show FPS in the title bar
            char title[64];
            std::snprintf(title, sizeof(title), "My 3D Game - %d FPS", frames);
            SetWindowTextA(hwnd, title);
            frames = 0;
            fpsTimer = 0;
        }
    }

    wglMakeCurrent(nullptr, nullptr);
    wglDeleteContext(rc);
    ReleaseDC(hwnd, dc);
    DestroyWindow(hwnd);
    return 0;
}
