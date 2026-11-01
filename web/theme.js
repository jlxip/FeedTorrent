const theme = matchMedia("(prefers-color-scheme: dark)");
const sync = () =>
  document.documentElement.classList.toggle("dark", theme.matches);
sync();
theme.addEventListener("change", sync);
