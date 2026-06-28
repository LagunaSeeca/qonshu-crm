"use client";

import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";
import { Sun, Moon, LogOut, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface TopbarProps {
  title?: string;
  userName?: string;
  userEmail?: string;
}

function getInitials(name?: string): string {
  if (!name) return "?";
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Topbar({
  title = "Dashboard",
  userName,
  userEmail,
}: TopbarProps) {
  const { theme, setTheme } = useTheme();

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  function handleSignOut() {
    signOut({ callbackUrl: "/login" });
  }

  const initials = getInitials(userName);

  return (
    <header className="h-14 border-b border-border bg-background flex items-center px-6 gap-4 shrink-0">
      {/* Page title */}
      <h1 className="text-base font-semibold text-foreground flex-1 truncate">
        {title}
      </h1>

      {/* Right side controls */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          {theme === "dark" ? (
            <Sun size={16} aria-hidden="true" />
          ) : (
            <Moon size={16} aria-hidden="true" />
          )}
        </Button>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-2 h-8 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            aria-label="User menu"
          >
            <Avatar className="h-6 w-6">
              <AvatarFallback className="text-[10px] font-semibold bg-accent text-accent-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            <ChevronDown size={12} aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-0.5">
                {userName && (
                  <span className="text-sm font-medium text-foreground">
                    {userName}
                  </span>
                )}
                {userEmail && (
                  <span className="text-xs text-muted-foreground truncate">
                    {userEmail}
                  </span>
                )}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-destructive focus:text-destructive cursor-pointer gap-2"
            >
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
