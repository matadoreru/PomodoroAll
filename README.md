# PomodoroAll— Estudia en tiempo real con amigos

Aplicación web de Pomodoro colaborativo en tiempo real. Temporizadores sincronizados, chat, reacciones y música de Spotify.

## Estructura del proyecto

```
pomodoro-sync/
├── package.json              ← Dependencias del servidor
├── server/
│   └── server.js             ← Backend Node.js + Socket.io
└── client/
    └── public/
        └── index.html        ← Frontend completo (HTML/CSS/JS)
```

## Requisitos

- Node.js 18+
- npm

## Instalación y arranque (desarrollo local)

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor
npm start
# ó con hot-reload:
npm run dev

# 3. Abrir en el navegador
# → http://localhost:3001
```

## Funcionalidades implementadas

### ⏱ Temporizador Pomodoro sincronizado
- Fases: Estudio (25 min), Descanso corto (5 min), Descanso largo (15 min)
- Sincronización en tiempo real entre todos los usuarios de la sala
- Si un usuario pausa, se pausa para todos
- Auto-avance a la siguiente fase al llegar a 0

### 👥 Salas colaborativas
- Crear sala con código único de 8 caracteres
- Unirse por código o enlace directo (`?room=XXXXXXXX`)
- Indicadores de estado en tiempo real: Conectado, Estudiando, Descansando, Ausente
- Máximo 8 usuarios por sala

### 💬 Chat integrado
- Chat de texto minimalista en panel lateral
- Ocultable con un botón
- Historial de los últimos 50 mensajes

### 🎉 Reacciones rápidas
- 6 emojis de ánimo: 🔥 💪 🎯 ⭐ ☕ 🎉
- Aparecen como elementos flotantes animados

### 🎵 Integración con Spotify
- Widget oficial de Spotify incrustado (sin autenticación)
- 4 playlists preseleccionadas: Lo-Fi, Synthwave, Clásica, Jazz

## Despliegue en producción

### Railway / Render / Fly.io
```bash
# Variable de entorno necesaria:
PORT=3001  # (o el puerto que asigne la plataforma)
```

El servidor sirve automáticamente los archivos del cliente.

### Con Nginx (VPS)
```nginx
server {
    listen 80;
    server_name tu-dominio.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Personalización

### Cambiar duraciones del temporizador
En `server/server.js`, función `createRoom()`:
```js
timeLeft: 25 * 60,  // ← minutos de estudio
```

En `client/public/index.html`, objeto `PHASE_DURATIONS`:
```js
const PHASE_DURATIONS = {
  study:        25 * 60,
  short_break:   5 * 60,
  long_break:   15 * 60,
};
```

### Cambiar playlists de Spotify
En `client/public/index.html`, objeto `SPOTIFY_PLAYLISTS`:
```js
const SPOTIFY_PLAYLISTS = {
  lofi: 'ID_DE_PLAYLIST_SPOTIFY',
  // ...
};
```
El ID está en la URL de Spotify: `open.spotify.com/playlist/[ESTE_ID]`

## Stack tecnológico

| Capa       | Tecnología                     |
|------------|-------------------------------|
| Frontend   | HTML5 + CSS3 + JavaScript ES6  |
| Backend    | Node.js + Express              |
| Tiempo real | Socket.io (WebSockets)        |
| Música     | Spotify Embed (oficial)        |
| Tipografía | Google Fonts (DM Serif + DM Sans) |
