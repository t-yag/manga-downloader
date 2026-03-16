import { Toaster } from "sonner";

export function ToastProvider() {
  return (
    <Toaster
      theme="dark"
      position="bottom-left"
      expand
      toastOptions={{
        style: {
          backgroundColor: "#1e293b",
          borderColor: "#334155",
          borderWidth: 1,
          color: "#f1f5f9",
        },
      }}
    />
  );
}
