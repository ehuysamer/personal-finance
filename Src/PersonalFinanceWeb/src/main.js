import { createApp } from "vue";
import App from "./App.vue";
import { createAuth } from "./lib/auth.js";
import { createApi } from "./lib/api.js";
import "./style.css";

const config = await fetch("/config.json", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ apiUrl: "", local: true }));
const auth = config.local ? { signedIn: () => true, idToken: async () => "", signOut: () => location.reload(), start: async () => {}, complete: async () => null } : createAuth(config);
const app = createApp(App);
app.provide("auth", auth);
app.provide("api", createApi(config, auth));
app.provide("config", config);
app.mount("#app");
