import type { Plugin, PluginContext } from "./types";
import CashflowView from "./CashflowView.svelte";
import { mount, unmount } from "svelte";

export const plugin: Plugin = {
  manifest: {
    id: "treeline-cashflow",
    name: "Cash Flow",
    version: "0.2.0",
    description: "Plan your future balance by scheduling expected income and expenses",
    author: "Treeline",
    permissions: {
      tables: {
        write: ["sys_plugin_treeline_cashflow_items"],
      },
    },
  },

  activate(context: PluginContext) {
    console.log("Cash Flow plugin activated!");

    // Register the view
    context.registerView({
      id: "cashflow-view",
      name: "Cash Flow",
      icon: "trending-up",
      mount: (target: HTMLElement, props: Record<string, any>) => {
        const instance = mount(CashflowView, {
          target,
          props,
        });

        return () => {
          unmount(instance);
        };
      },
    });

    // Add sidebar item
    context.registerSidebarItem({
      sectionId: "main",
      id: "treeline-cashflow",
      label: "Cash Flow",
      icon: "trending-up",
      viewId: "cashflow-view",
    });

    console.log("✓ Cash Flow plugin registered");
  },

  deactivate() {
    console.log("Cash Flow plugin deactivated");
  },
};
