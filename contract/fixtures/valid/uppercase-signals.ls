@episode main:01 "Uppercase signal contract" {

@signal mark FIRST_MEETING
@signal int LOVE_POINTS +1

@if (FIRST_MEETING) {
  @if (LOVE_POINTS >= 1) {
    NARRATOR: The contract is active.
  }
}

@if (san >= 0) {
  NARRATOR: Lowercase engine values remain readable.
}

@gate {
  @end complete
}
}
