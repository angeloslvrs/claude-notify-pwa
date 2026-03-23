self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Claude Code";
  const isWaiting = data.event === "notification";
  const options = {
    body: data.body || "Task completed",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: isWaiting ? "claude-notif-waiting" : "claude-notif",
    renotify: true,
    requireInteraction: isWaiting,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
