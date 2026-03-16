import { Toaster } from "sonner-native";

export function ToastProvider() {
  return (
    <Toaster
      theme="dark"
      position="bottom-center"
      duration={2500}
      toastOptions={{
        style: {
          backgroundColor: "#1e293b",
          borderColor: "#334155",
          borderWidth: 1,
        },
        titleStyle: { color: "#f1f5f9" },
        descriptionStyle: { color: "#94a3b8" },
      }}
    />
  );
}
