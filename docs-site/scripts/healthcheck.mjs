import { get } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);

const request = get(
  {
    host: "127.0.0.1",
    path: "/healthz",
    port,
    timeout: 2000,
  },
  (response) => {
    response.resume();
    if (response.statusCode !== 200) {
      process.exitCode = 1;
    }
  },
);

request.on("timeout", () => request.destroy(new Error("Health check timed out.")));
request.on("error", () => {
  process.exitCode = 1;
});
