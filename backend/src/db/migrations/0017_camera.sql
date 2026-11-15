-- PrintYard: printer camera. Creality K-series printers serve it with MJPG-streamer (port 8080); it was never
-- configurable before, so every existing printer starts with it on (the app shows "no camera" when none answers).
UPDATE printers SET camera = '{"type":"mjpeg"}' WHERE camera = '{"type":"none"}';
