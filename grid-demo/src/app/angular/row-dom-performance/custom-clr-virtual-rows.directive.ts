import { Directionality } from '@angular/cdk/bidi';
import { coerceNumberProperty } from '@angular/cdk/coercion';
import { ListRange, _RecycleViewRepeaterStrategy } from '@angular/cdk/collections';
import {
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualForOfContext,
  CdkVirtualScrollViewport,
  FixedSizeVirtualScrollStrategy,
  ScrollDispatcher,
  ViewportRuler,
} from '@angular/cdk/scrolling';
import {
  ChangeDetectorRef,
  Directive,
  DoCheck,
  ElementRef,
  EmbeddedViewRef,
  EventEmitter,
  Input,
  IterableDiffers,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';
import { ClrDatagrid } from '@clr/angular';
import { fromEvent, Subscription } from 'rxjs';

import { fromActiveCell } from '../helpers/datagrid-active-cell.helpers';
import { getDatagridElementRef, getDatagridKeyNavigationController } from '../helpers/datagrid-private-member.helpers';

interface CellCoordinates {
  itemIndex: number;
  columnIndex: number;
}

type CdkVirtualForInputKey =
  | 'cdkVirtualForOf'
  | 'cdkVirtualForTrackBy'
  | 'cdkVirtualForTemplate'
  | 'cdkVirtualForTemplateCacheSize';

type CdkVirtualForInputs<T> = Partial<Pick<CdkVirtualForOf<T>, CdkVirtualForInputKey>>;

type CdkFixedSizeVirtualScrollInputs = Pick<CdkFixedSizeVirtualScroll, 'itemSize' | 'minBufferPx' | 'maxBufferPx'>;

const defaultCdkFixedSizeVirtualScrollInputs: CdkFixedSizeVirtualScrollInputs = {
  itemSize: 36,
  minBufferPx: 100,
  maxBufferPx: 200,
};

@Directive({
  selector: '[customClrVirtualRows][customClrVirtualRowsOf]',
})
export class CustomClrVirtualRowsDirective<T> implements OnInit, DoCheck, OnDestroy {
  @Input('customClrVirtualRowsOf')
  get cdkVirtualForOf() {
    return this._cdkVirtualForInputs.cdkVirtualForOf;
  }
  set cdkVirtualForOf(value: CdkVirtualForInputs<T>['cdkVirtualForOf']) {
    this._cdkVirtualForInputs.cdkVirtualForOf = value;
    this.updateCdkVirtualForInputs();
  }

  @Input('customClrVirtualRowsTrackBy')
  get cdkVirtualForTrackBy() {
    return this._cdkVirtualForInputs.cdkVirtualForTrackBy;
  }
  set cdkVirtualForTrackBy(value: CdkVirtualForInputs<T>['cdkVirtualForTrackBy']) {
    this._cdkVirtualForInputs.cdkVirtualForTrackBy = value;
    this.updateCdkVirtualForInputs();
  }

  @Input('customClrVirtualRowsTemplate')
  get cdkVirtualForTemplate() {
    return this._cdkVirtualForInputs.cdkVirtualForTemplate!;
  }
  set cdkVirtualForTemplate(value: CdkVirtualForInputs<T>['cdkVirtualForTemplate']) {
    this._cdkVirtualForInputs.cdkVirtualForTemplate = value;
    this.updateCdkVirtualForInputs();
  }

  @Input('customClrVirtualRowsTemplateCacheSize')
  get cdkVirtualForTemplateCacheSize() {
    return this._cdkVirtualForInputs.cdkVirtualForTemplateCacheSize;
  }
  set cdkVirtualForTemplateCacheSize(value: CdkVirtualForInputs<T>['cdkVirtualForTemplateCacheSize']) {
    this._cdkVirtualForInputs.cdkVirtualForTemplateCacheSize = coerceNumberProperty(value);
    this.updateCdkVirtualForInputs();
  }

  @Input('customClrVirtualRowsItemSize')
  get itemSize() {
    return this._cdkFixedSizeVirtualScrollInputs.itemSize;
  }
  set itemSize(value: CdkFixedSizeVirtualScrollInputs['itemSize']) {
    this._cdkFixedSizeVirtualScrollInputs.itemSize = coerceNumberProperty(value);
    this.updateFixedSizeVirtualScrollInputs();
  }

  @Input('customClrVirtualRowsMinBufferPx')
  get minBufferPx() {
    return this._cdkFixedSizeVirtualScrollInputs.minBufferPx;
  }
  set minBufferPx(value: CdkFixedSizeVirtualScrollInputs['minBufferPx']) {
    this._cdkFixedSizeVirtualScrollInputs.minBufferPx = coerceNumberProperty(value);
    this.updateFixedSizeVirtualScrollInputs();
  }

  @Input('customClrVirtualRowsMaxBufferPx')
  get maxBufferPx() {
    return this._cdkFixedSizeVirtualScrollInputs.maxBufferPx;
  }
  set maxBufferPx(value: CdkFixedSizeVirtualScrollInputs['maxBufferPx']) {
    this._cdkFixedSizeVirtualScrollInputs.maxBufferPx = coerceNumberProperty(value);
    this.updateFixedSizeVirtualScrollInputs();
  }

  @Input('customClrVirtualRowsKeyboardScrollPageSize') keyboardScrollPageSize = 10;

  @Output() renderedRangeChange = new EventEmitter<ListRange>();

  private _cdkVirtualForInputs: CdkVirtualForInputs<T> = {
    cdkVirtualForTrackBy: index => index,
  };

  private _cdkFixedSizeVirtualScrollInputs = { ...defaultCdkFixedSizeVirtualScrollInputs };

  private datagridElementRef: ElementRef<HTMLElement> = getDatagridElementRef(this.datagrid);
  private datagridKeyNavigationController = getDatagridKeyNavigationController(this.datagrid);

  private gridRoleElement: HTMLElement | null | undefined;
  private virtualScrollStrategy: FixedSizeVirtualScrollStrategy | undefined;
  private virtualScrollViewport: CdkVirtualScrollViewport | undefined;
  private cdkVirtualFor: CdkVirtualForOf<T> | undefined;
  private setActiveCellSubscription: Subscription | undefined;
  private dataStreamSubscription: Subscription | undefined;
  private renderedRangeChangeSubscription: Subscription | undefined;
  private keydownEventSubscription: Subscription | undefined;
  private totalSize = 0;
  private activeCellCoordinates: CellCoordinates | undefined;
  private nextActiveCellCoordinates: CellCoordinates | undefined;

  constructor(
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly iterableDiffers: IterableDiffers,
    private readonly ngZone: NgZone,
    private readonly templateRef: TemplateRef<CdkVirtualForOfContext<T>>,
    private readonly viewContainerRef: ViewContainerRef,
    private readonly directionality: Directionality,
    private readonly scrollDispatcher: ScrollDispatcher,
    private readonly viewportRuler: ViewportRuler,
    private readonly datagrid: ClrDatagrid
  ) {}

  ngOnInit() {
    this.gridRoleElement = this.datagridElementRef.nativeElement.querySelector<HTMLElement>('[role="grid"]');

    this.virtualScrollStrategy = new FixedSizeVirtualScrollStrategy(
      this._cdkFixedSizeVirtualScrollInputs.itemSize,
      this._cdkFixedSizeVirtualScrollInputs.minBufferPx,
      this._cdkFixedSizeVirtualScrollInputs.maxBufferPx
    );

    this.virtualScrollViewport = createVirtualScrollViewportForDatagrid(
      this.changeDetectorRef,
      this.ngZone,
      this.directionality,
      this.scrollDispatcher,
      this.viewportRuler,
      this.datagridElementRef,
      this.virtualScrollStrategy
    );

    const viewRepeaterStrategy = new _RecycleViewRepeaterStrategy<T, T, CdkVirtualForOfContext<T>>();

    this.cdkVirtualFor = new CdkVirtualForOf<T>(
      this.viewContainerRef,
      this.templateRef,
      this.iterableDiffers,
      viewRepeaterStrategy,
      this.virtualScrollViewport,
      this.ngZone
    );

    this.updateCdkVirtualForInputs();

    this.virtualScrollViewport.ngOnInit();

    this.setActiveCellSubscription = fromActiveCell(this.datagrid).subscribe(activeCellElement => {
      this.activeCellCoordinates = this.getCellCoordinates(activeCellElement);
    });

    this.dataStreamSubscription = this.cdkVirtualFor.dataStream.subscribe(data => {
      this.totalSize = data.length;
      this.updateAriaRowCount(data.length);
    });

    this.renderedRangeChangeSubscription = this.virtualScrollViewport.renderedRangeStream.subscribe(renderedRange => {
      this.renderedRangeChange.emit(renderedRange);
      this.restoreOrUpdateActiveCellInNextFrame();
    });

    this.keydownEventSubscription = fromEvent<KeyboardEvent>(this.gridRoleElement!, 'keydown').subscribe(event => {
      this.handlePageUpAndPageDownKeys(event);
    });
  }

  ngDoCheck() {
    this.cdkVirtualFor?.ngDoCheck();
    this.updateAriaRowIndexes();
  }

  ngOnDestroy() {
    this.cdkVirtualFor?.ngOnDestroy();
    this.virtualScrollViewport?.ngOnDestroy();
    this.setActiveCellSubscription?.unsubscribe();
    this.dataStreamSubscription?.unsubscribe();
    this.renderedRangeChangeSubscription?.unsubscribe();
    this.keydownEventSubscription?.unsubscribe();
  }

  private restoreOrUpdateActiveCellInNextFrame() {
    setTimeout(() => {
      this.promoteNextActiveCell();

      const activeCellElement = this.activeCellCoordinates
        ? this.getCellElement(this.activeCellCoordinates)
        : undefined;

      if (activeCellElement) {
        this.datagridKeyNavigationController.setActiveCell(activeCellElement);
      }
    });
  }

  private updateCdkVirtualForInputs() {
    if (this.cdkVirtualFor) {
      for (const cdkVirtualForInputKey of Object.keys(this._cdkVirtualForInputs) as CdkVirtualForInputKey[]) {
        if (this.cdkVirtualFor[cdkVirtualForInputKey] !== this._cdkVirtualForInputs[cdkVirtualForInputKey]) {
          (this.cdkVirtualFor as any)[cdkVirtualForInputKey] = this._cdkVirtualForInputs[cdkVirtualForInputKey];
        }
      }
    }
  }

  private updateFixedSizeVirtualScrollInputs() {
    if (this.virtualScrollStrategy) {
      this.virtualScrollStrategy.updateItemAndBufferSize(
        this._cdkFixedSizeVirtualScrollInputs.itemSize,
        this._cdkFixedSizeVirtualScrollInputs.minBufferPx,
        this._cdkFixedSizeVirtualScrollInputs.maxBufferPx
      );
    }
  }

  private updateAriaRowCount(rowCount: number) {
    this.gridRoleElement?.setAttribute('aria-rowcount', rowCount.toString());
  }

  private updateAriaRowIndexes() {
    for (let i = 0; i < this.viewContainerRef.length; i++) {
      const viewRef = this.viewContainerRef.get(i) as EmbeddedViewRef<CdkVirtualForOfContext<T>>;

      const rootElements: HTMLElement[] = viewRef.rootNodes;
      const datagridRowElement = rootElements.find(rowElement => rowElement.tagName === 'CLR-DG-ROW');
      const rowRoleElement = datagridRowElement?.querySelector('[role="row"]');

      // aria-rowindex should start with one, not zero, so we have to add one to the zero-based index
      rowRoleElement?.setAttribute('aria-rowindex', (viewRef.context.index + 1).toString());
    }
  }

  private handlePageUpAndPageDownKeys(event: KeyboardEvent) {
    if (this.activeCellCoordinates && (event.code === 'PageUp' || event.code === 'PageDown')) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const { itemIndex: activeItemIndex, columnIndex: activeColumnIndex } = this.activeCellCoordinates;

      if (!isNaN(activeItemIndex)) {
        const nextItemIndex =
          event.code === 'PageUp'
            ? Math.max(0, activeItemIndex - this.keyboardScrollPageSize)
            : Math.min(this.totalSize - 1, activeItemIndex + this.keyboardScrollPageSize);

        this.nextActiveCellCoordinates = {
          itemIndex: nextItemIndex,
          columnIndex: activeColumnIndex,
        };

        this.virtualScrollViewport?.scrollToIndex(nextItemIndex);
        this.restoreOrUpdateActiveCellInNextFrame();
      }
    }
  }

  private promoteNextActiveCell() {
    if (this.nextActiveCellCoordinates) {
      this.activeCellCoordinates = this.nextActiveCellCoordinates;
      this.nextActiveCellCoordinates = undefined;
    }
  }

  private getCellCoordinates(cellElement: HTMLElement) {
    const rowElement = cellElement.closest('[role="row"][aria-rowindex]');
    const rowIndex = parseInt(rowElement?.getAttribute('aria-rowindex')!);

    // aria-rowindex starts with one, not zero, so we have to subtract one to get the zero-based index
    const itemIndex = rowIndex - 1;

    const cellElements = Array.from(rowElement?.querySelectorAll('clr-dg-cell') || []);

    const cellCoordinates: CellCoordinates = {
      itemIndex,
      columnIndex: cellElements.indexOf(cellElement),
    };

    return cellCoordinates;
  }

  private getCellElement({ itemIndex, columnIndex }: CellCoordinates) {
    // aria-rowindex should start with one, not zero, so we have to add one to the zero-based index
    const rowIndex = itemIndex + 1;

    const rowElementSelector = `[role="row"][aria-rowindex="${rowIndex}"]`;
    const rowElement = this.datagridElementRef.nativeElement.querySelector(rowElementSelector);
    const cellElements = Array.from(rowElement?.querySelectorAll<HTMLElement>('clr-dg-cell') || []);

    return cellElements[columnIndex];
  }
}

function createVirtualScrollViewportForDatagrid(
  changeDetectorRef: ChangeDetectorRef,
  ngZone: NgZone,
  directionality: Directionality,
  scrollDispatcher: ScrollDispatcher,
  viewportRuler: ViewportRuler,
  datagridElementRef: ElementRef<HTMLElement>,
  virtualScrollStrategy: FixedSizeVirtualScrollStrategy
) {
  const datagridDivElement = datagridElementRef.nativeElement.querySelector<HTMLElement>('.datagrid')!;
  const datagridTableElement = datagridElementRef.nativeElement.querySelector<HTMLElement>('.datagrid-table')!;
  const datagridHeaderElement = datagridElementRef.nativeElement.querySelector<HTMLElement>('.datagrid-header')!;
  const datagridDivElementRef: ElementRef<HTMLElement> = { nativeElement: datagridDivElement };

  let topOffset = 0;
  let totalContentSize = 0;

  function updateDatagridElementStyles() {
    datagridTableElement.style.transform = `translateY(${topOffset}px)`;
    datagridTableElement.style.height = `${totalContentSize - topOffset}px`;
    datagridHeaderElement.style.top = `-${topOffset}px`;
  }

  const virtualScrollViewport = new CdkVirtualScrollViewport(
    datagridDivElementRef,
    changeDetectorRef,
    ngZone,
    virtualScrollStrategy,
    directionality,
    scrollDispatcher,
    viewportRuler
  );

  const virtualScrollViewportContentWrapperElementRef: ElementRef = {
    nativeElement: {
      style: {
        set transform(value: any) {
          topOffset = value === undefined ? 0 : +/translateY\(([0-9]+)px\)/.exec(value)![1];
          updateDatagridElementStyles();
        },
      },
    },
  };

  virtualScrollViewport._contentWrapper = virtualScrollViewportContentWrapperElementRef;

  virtualScrollViewport.setTotalContentSize = (value: number) => {
    totalContentSize = value;
    updateDatagridElementStyles();
  };

  return virtualScrollViewport;
}
