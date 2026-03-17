"use client";

import { cn } from "@/lib/utils";
import type { Tab } from "@/types";

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="flex items-center gap-1 p-1 bg-zinc-100 rounded-lg w-fit min-w-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              "px-3 sm:px-4 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all duration-150 select-none whitespace-nowrap",
              activeTab === tab.id
                ? "bg-ink text-paper shadow-sm"
                : "text-ink-muted hover:text-ink hover:bg-surface"
            )}
          >
            {tab.label}{" "}
            <span
              className={cn(
                "ml-0.5 text-xs",
                activeTab === tab.id ? "text-ink-faint" : "text-ink-faint"
              )}
            >
              ({tab.count})
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
