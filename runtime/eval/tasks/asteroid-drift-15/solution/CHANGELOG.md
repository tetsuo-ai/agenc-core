# Changelog

1. Scaffold: index.html, canvas, requestAnimationFrame loop with delta time, arrow-key ship.
2. Asteroids fall from random x with rising speed; a hit ends the game with Game Over.
3. Score counts seconds survived; best score persists in localStorage.
4. Start screen and pause on P.
5. Refactor into player.js, asteroids.js, hud.js and main.js.
6. Particle explosion and screen shake on death.
7. WebAudio oscillator beeps with a mute toggle on M, remembered in localStorage.
8. Shield and slow-time power-ups spawn every ten seconds.
9. Levels every 20 points with faster spawns and a banner.
10. Touch and pointer controls plus a responsive canvas.
11. node:test coverage for collision, scoring and leveling.
12. README with controls and a dependency-free npm start server.
13. Self-review: keyup lost on blur now clears input; shield consumes the asteroid.
14. Top-five high score table with initials in localStorage.
15. Final check: tests pass, style rules hold, this changelog written.
