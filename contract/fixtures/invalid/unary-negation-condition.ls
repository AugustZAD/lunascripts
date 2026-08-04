@episode main:01 "Unary negation is invalid" {
@if (READY && !BE_DROPPED) {
  YOU: This must not parse.
}
@gate {
  @end complete
}
}
