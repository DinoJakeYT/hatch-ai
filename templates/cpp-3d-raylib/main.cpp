// Hatch starter: a 3D game with raylib (install it once from Hatch: Settings > Local models > raylib).
// Build: see "Tools on this PC" for the exact raylib build command.
// Controls: W/A/S/D move, arrow keys look around, Esc quits.
// Change the update part for game rules and the drawing part for what's shown.
#include "raylib.h"
#include "raymath.h"   // Vector3Add, Vector3Distance, Clamp... and + - * on Vector3 in C++
#include <cmath>

int main() {
    InitWindow(1280, 720, "My 3D Game");
    SetTargetFPS(60);

    Camera3D camera = {};
    camera.position = { 0.0f, 2.0f, 7.0f };
    camera.target = { 0.0f, 1.0f, 0.0f };
    camera.up = { 0.0f, 1.0f, 0.0f };
    camera.fovy = 60.0f;
    camera.projection = CAMERA_PERSPECTIVE;

    while (!WindowShouldClose()) {
        // ---- update ----
        float dt = GetFrameTime();
        float t = (float)GetTime();
        Vector3 move = {
            (float)(IsKeyDown(KEY_W) - IsKeyDown(KEY_S)) * 6.0f * dt,          // forward
            (float)(IsKeyDown(KEY_D) - IsKeyDown(KEY_A)) * 6.0f * dt,          // right
            0.0f };
        Vector3 look = {
            (float)(IsKeyDown(KEY_RIGHT) - IsKeyDown(KEY_LEFT)) * 100.0f * dt, // yaw
            (float)(IsKeyDown(KEY_DOWN) - IsKeyDown(KEY_UP)) * 70.0f * dt,     // pitch
            0.0f };
        UpdateCameraPro(&camera, move, look, 0.0f);

        // ---- draw ----
        BeginDrawing();
        ClearBackground(SKYBLUE);
        BeginMode3D(camera);
        DrawPlane({ 0.0f, 0.0f, 0.0f }, { 100.0f, 100.0f }, DARKGREEN);
        DrawGrid(50, 2.0f);
        for (int i = 0; i < 12; i++) {
            float a = i * 2.0f * PI / 12.0f;
            Vector3 p = { cosf(a) * 10.0f, 0.75f, sinf(a) * 10.0f };
            DrawCube(p, 1.5f, 1.5f, 1.5f, ORANGE);
            DrawCubeWires(p, 1.5f, 1.5f, 1.5f, BROWN);
        }
        DrawCube({ 0.0f, 1.5f + sinf(t * 2.0f) * 0.4f, 0.0f }, 1.2f, 1.2f, 1.2f, RED);
        EndMode3D();
        DrawText("WASD move, arrows look, Esc quit", 12, 12, 20, WHITE);
        DrawFPS(12, 40);
        EndDrawing();
    }
    CloseWindow();
    return 0;
}
