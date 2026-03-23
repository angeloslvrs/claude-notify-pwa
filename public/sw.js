self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Claude Code";
  const isWaiting = data.event === "notification";
  const isPermission = data.event === "permission";

  const options = {
    body: data.body || "Task completed",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { event: data.event, permissionId: data.permissionId || null },
    tag: isPermission ? "claude-notif-permission"
       : isWaiting ? "claude-notif-waiting"
       : "claude-notif",
    renotify: true,
    requireInteraction: isWaiting || isPermission,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.permissionId
    ? "/?permission=" + data.permissionId
    : "/";

  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "navigate" in client) {
          return client.navigate(url).then(() => client.focus());
        }
      }
      return clients.openWindow(url);
    })
  );
});
