import type * as React from 'react';

export interface UiButtonProps extends React.ComponentProps<'button'> {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link' | null;
  size?: 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg' | null;
  asChild?: boolean;
}

export interface UiOpenProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

export interface UiDialogProps extends UiOpenProps {
  modal?: boolean;
}

export interface UiDialogContentProps extends React.ComponentProps<'div'> {
  asChild?: boolean;
  forceMount?: true;
  showCloseButton?: boolean;
  onOpenAutoFocus?(event: Event): void;
  onCloseAutoFocus?(event: Event): void;
  onEscapeKeyDown?(event: KeyboardEvent): void;
  onPointerDownOutside?(event: Event): void;
  onFocusOutside?(event: Event): void;
  onInteractOutside?(event: Event): void;
}

export interface UiBadgeProps extends React.ComponentProps<'span'> {
  variant?: UiButtonProps['variant'];
  asChild?: boolean;
}

export interface UiCheckboxProps extends Omit<React.ComponentProps<'button'>, 'defaultChecked' | 'value'> {
  checked?: boolean | 'indeterminate';
  defaultChecked?: boolean | 'indeterminate';
  onCheckedChange?(checked: boolean | 'indeterminate'): void;
  required?: boolean;
  value?: string;
}

export interface UiSwitchProps extends Omit<React.ComponentProps<'button'>, 'defaultChecked' | 'value'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?(checked: boolean): void;
  required?: boolean;
  value?: string;
  size?: 'sm' | 'default';
}

export interface UiSelectProps extends UiOpenProps {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  name?: string;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
  dir?: 'ltr' | 'rtl';
  form?: string;
}

export interface UiSelectContentProps extends React.ComponentProps<'div'> {
  position?: 'item-aligned' | 'popper';
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  onCloseAutoFocus?(event: Event): void;
  onEscapeKeyDown?(event: KeyboardEvent): void;
  onPointerDownOutside?(event: Event): void;
}

export interface UiMenuContentProps extends React.ComponentProps<'div'> {
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  onCloseAutoFocus?(event: Event): void;
  onEscapeKeyDown?(event: KeyboardEvent): void;
  onInteractOutside?(event: Event): void;
}

export interface UiMenuItemProps extends Omit<React.ComponentProps<'div'>, 'onSelect'> {
  asChild?: boolean;
  inset?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'destructive';
  textValue?: string;
  onSelect?(event: Event): void;
}

type Component<Props> = React.ComponentType<Props>;
type DivProps = React.ComponentProps<'div'>;
type TriggerProps = React.ComponentProps<'button'> & { asChild?: boolean };

/** Actual host components, not a second React runtime or a CSS fallback. */
export interface ModuleUi {
  readonly version: 1;
  readonly Button: Component<UiButtonProps>;
  readonly Input: Component<React.ComponentProps<'input'>>;
  readonly Textarea: Component<React.ComponentProps<'textarea'>>;
  readonly Label: Component<React.ComponentProps<'label'>>;
  readonly Badge: Component<UiBadgeProps>;
  readonly Checkbox: Component<UiCheckboxProps>;
  readonly Switch: Component<UiSwitchProps>;
  readonly Separator: Component<DivProps & { orientation?: 'horizontal' | 'vertical'; decorative?: boolean }>;
  readonly Alert: Component<DivProps & { variant?: 'default' | 'destructive' | null }>;
  readonly AlertTitle: Component<DivProps>;
  readonly AlertDescription: Component<DivProps>;
  readonly Dialog: Component<UiDialogProps>;
  readonly DialogTrigger: Component<TriggerProps>;
  readonly DialogClose: Component<TriggerProps>;
  readonly DialogContent: Component<UiDialogContentProps>;
  readonly DialogHeader: Component<DivProps>;
  readonly DialogFooter: Component<DivProps & { showCloseButton?: boolean }>;
  readonly DialogTitle: Component<React.ComponentProps<'h2'>>;
  readonly DialogDescription: Component<React.ComponentProps<'p'>>;
  readonly AlertDialog: Component<UiOpenProps>;
  readonly AlertDialogTrigger: Component<TriggerProps>;
  readonly AlertDialogContent: Component<Omit<UiDialogContentProps, 'showCloseButton' | 'onPointerDownOutside' | 'onFocusOutside' | 'onInteractOutside'> & { size?: 'default' | 'sm' }>;
  readonly AlertDialogHeader: Component<DivProps>;
  readonly AlertDialogFooter: Component<DivProps>;
  readonly AlertDialogTitle: Component<React.ComponentProps<'h2'>>;
  readonly AlertDialogDescription: Component<React.ComponentProps<'p'>>;
  readonly AlertDialogAction: Component<UiButtonProps>;
  readonly AlertDialogCancel: Component<UiButtonProps>;
  readonly Select: Component<UiSelectProps>;
  readonly SelectTrigger: Component<TriggerProps & { size?: 'sm' | 'default' }>;
  readonly SelectValue: Component<React.ComponentProps<'span'> & { placeholder?: React.ReactNode }>;
  readonly SelectContent: Component<UiSelectContentProps>;
  readonly SelectItem: Component<DivProps & { value: string; disabled?: boolean; textValue?: string }>;
  readonly SelectGroup: Component<DivProps>;
  readonly SelectLabel: Component<DivProps>;
  readonly DropdownMenu: Component<UiDialogProps & { dir?: 'ltr' | 'rtl' }>;
  readonly DropdownMenuTrigger: Component<TriggerProps>;
  readonly DropdownMenuContent: Component<UiMenuContentProps>;
  readonly DropdownMenuItem: Component<UiMenuItemProps>;
  readonly DropdownMenuGroup: Component<DivProps>;
  readonly DropdownMenuLabel: Component<DivProps & { inset?: boolean }>;
  readonly DropdownMenuSeparator: Component<DivProps>;
  readonly Collapsible: Component<DivProps & UiOpenProps & { disabled?: boolean }>;
  readonly CollapsibleTrigger: Component<TriggerProps>;
  readonly CollapsibleContent: Component<DivProps & { forceMount?: true }>;
  readonly Tooltip: Component<UiOpenProps & { delayDuration?: number; disableHoverableContent?: boolean }>;
  readonly TooltipTrigger: Component<TriggerProps>;
  readonly TooltipContent: Component<Omit<UiMenuContentProps, 'onCloseAutoFocus' | 'onInteractOutside'>>;
}
