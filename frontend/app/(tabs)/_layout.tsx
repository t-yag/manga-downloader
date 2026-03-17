import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { colors } from "../../src/theme";

const NATIVE_TAB_CONTENT_STYLE = { backgroundColor: colors.bg };

function NativeTabsLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index" contentStyle={NATIVE_TAB_CONTENT_STYLE}>
        <NativeTabs.Trigger.Icon
          sf={{ default: "books.vertical", selected: "books.vertical.fill" }}
        />
        <NativeTabs.Trigger.Label>ライブラリ</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tags" contentStyle={NATIVE_TAB_CONTENT_STYLE}>
        <NativeTabs.Trigger.Icon
          sf={{ default: "tag", selected: "tag.fill" }}
        />
        <NativeTabs.Trigger.Label>タグ管理</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="jobs/index" contentStyle={NATIVE_TAB_CONTENT_STYLE}>
        <NativeTabs.Trigger.Icon
          sf={{
            default: "arrow.down.circle",
            selected: "arrow.down.circle.fill",
          }}
        />
        <NativeTabs.Trigger.Label>ジョブ</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={NATIVE_TAB_CONTENT_STYLE}>
        <NativeTabs.Trigger.Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
        />
        <NativeTabs.Trigger.Label>設定</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function DefaultTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accentLight,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: Platform.OS === "web"
          ? { display: "none" }
          : {
              backgroundColor: colors.bg,
              borderTopColor: colors.border,
              borderTopWidth: 1,
              paddingBottom: 4,
              height: 56,
            },
        headerStyle: {
          backgroundColor: colors.bg,
        },
        headerTintColor: colors.textPrimary,
        headerTitleStyle: {
          fontWeight: "700",
          fontSize: 17,
        },
        headerShadowVisible: false,
        ...(Platform.OS === "web" && { headerShown: false }),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "ライブラリ",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="library" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="tags"
        options={{
          title: "タグ管理",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="pricetag" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="jobs/index"
        options={{
          title: "ジョブ",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="download" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "設定",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

export default function TabsLayout() {
  if (Platform.OS === "ios") {
    return <NativeTabsLayout />;
  }
  return <DefaultTabsLayout />;
}
