import type { ModuleUi } from '@cockpit/module-api';
import {
  Button, Input, Textarea, Label, Badge, Checkbox, Switch,
  Alert, AlertTitle, AlertDescription,
  Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup,
  DropdownMenuLabel, DropdownMenuSeparator,
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuGroup,
  ContextMenuLabel, ContextMenuSeparator,
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from '@cockpit/ui';

export const nextUi = Object.freeze({
  version: 1, Button, Input, Textarea, Label, Badge, Checkbox, Switch,
  Alert, AlertTitle, AlertDescription,
  Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup,
  DropdownMenuLabel, DropdownMenuSeparator,
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuGroup,
  ContextMenuLabel, ContextMenuSeparator,
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} satisfies ModuleUi);
