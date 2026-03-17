import { Stack, useRouter, usePathname } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ToastProvider } from "../src/components/ToastProvider";
import { Platform, View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../src/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
});

const SIDEBAR_WIDTH = 180;

const SIDEBAR_ITEMS: { href: string; matchPrefix: string; title: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { href: "/", matchPrefix: "/", title: "ライブラリ", icon: "library" },
  { href: "/tags", matchPrefix: "/tags", title: "タグ管理", icon: "pricetag" },
  { href: "/jobs", matchPrefix: "/jobs", title: "ジョブ", icon: "download" },
  { href: "/settings", matchPrefix: "/settings", title: "設定", icon: "settings" },
];

function WebSidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (item: (typeof SIDEBAR_ITEMS)[number]) => {
    if (item.href === "/") {
      return pathname === "/" || pathname.startsWith("/library");
    }
    return pathname.startsWith(item.matchPrefix);
  };

  return (
    <View style={sidebarStyles.sidebar}>
      {SIDEBAR_ITEMS.map((item) => {
        const focused = isActive(item);
        const color = focused ? colors.accentLight : colors.textMuted;

        return (
          <TouchableOpacity
            key={item.href}
            style={[sidebarStyles.item, focused && sidebarStyles.itemActive]}
            onPress={() => router.navigate(item.href as any)}
          >
            <Ionicons name={item.icon} size={20} color={color} />
            <Text style={[sidebarStyles.label, { color }]}>{item.title}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const sidebarStyles = StyleSheet.create({
  sidebar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: SIDEBAR_WIDTH,
    backgroundColor: colors.bg,
    borderRightColor: colors.border,
    borderRightWidth: 1,
    paddingTop: 32,
    paddingHorizontal: 8,
    gap: 4,
    zIndex: 1,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  itemActive: {
    backgroundColor: colors.bgCard,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
  },
});

const isWeb = Platform.OS === "web";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          {isWeb && <WebSidebar />}
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.textPrimary,
              headerTitleStyle: { fontWeight: "700", fontSize: 17 },
              headerShadowVisible: false,
              contentStyle: {
                backgroundColor: colors.bg,
                ...(isWeb && { marginLeft: SIDEBAR_WIDTH }),
              },
            }}
          >
            <Stack.Screen
              name="(tabs)"
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="library/[id]"
              options={{
                headerShown: false,
              }}
            />
          </Stack>
          <ToastProvider />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
